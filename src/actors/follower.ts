import * as THREE from 'three';
import type { ColliderWorld } from '../world/collision';

/**
 * Navmesh-free companion steering (§4.5): seek a slot behind/beside the
 * leader with arrival slow-down, lag and separation — companions should
 * trail naturally, cut corners a little, and never vibrate against the
 * leader's heels. Collision via ColliderWorld.resolveCircle, ground via
 * heightAt. When the leader idles >3 s: Jonas looks around (lookAt drift),
 * Birk eventually sits.
 *
 * CONTRACT (frozen):
 * - Follower owns its actor's position each frame: compute steering →
 *   resolve collision → write actor.group.position, then call
 *   actor.setLocomotion(actualSpeed, heading) and actor.update().
 * - update() takes the leader's position + yaw; zero allocations.
 */
export interface FollowableActor {
  group: THREE.Group;
  setLocomotion(speed: number, yaw: number): void;
  update(dt: number, elapsed: number): void;
  lookAt?(target: THREE.Vector3 | null): void;
  sit?(): void;
  stand?(): void;
}

export interface FollowerOptions {
  /** Slot behind the leader in metres. */
  offsetBack: number;
  /** Slot sideways (+ = leader's right). */
  offsetSide: number;
  maxSpeed: number;
  /** Radius for collision + separation. */
  radius: number;
  /** Seconds of leader idling before idle behaviours kick in. */
  idleDelay?: number;
}

// ---- tuning (feel target: lag, drift, no vibration, no wall-kissing) ----
const SLOT_EASE_RATE = 3; // Hz — smoothed slot soaks up leader turn whip
const ARRIVE_DEAD = 0.25; // m — inside this the follower wants speed 0
const ARRIVE_RANGE = 1.4; // m — speed ramps to max over this distance
const CATCHUP_DIST = 7; // m — beyond this, hurry
const CATCHUP_MULT = 1.35;
const ACCEL = 6; // m/s² — velocity ease toward desired
const SEP_PAD = 0.45; // m — separation kicks in inside radius + pad
const SEP_ACCEL = 10; // m/s² per metre of overlap
const LEADER_CLEARANCE = 0.6; // m — never crowd the leader's heels
const GROUND_EASE_RATE = 12; // Hz — same step-up/down feel as the player
const MOVE_SPEED_EPS = 0.15; // m/s — below this, face the leader's way
const IDLE_TURN_RATE = 2.5; // rad/s heading ease when idle
const LEADER_MOVING_SPEED = 0.3; // m/s — leader-stationary detector
const GLANCE_PERIOD = 4; // s — mean time between idle glance re-picks
const SIT_DELAY_MULT = 3; // Birk sits after idleDelay × this

// Collision scratch (resolveCircle mutates {x,z} in place).
const _resolve = { x: 0, z: 0 };

export class Follower {
  /** Current feet position — pass this in the shared `others` array. */
  readonly position = new THREE.Vector3();
  /** World yaw handed to setLocomotion (actor adds its own rotation lag). */
  heading = 0;

  private readonly actor: FollowableActor;
  private readonly offsetBack: number;
  private readonly offsetSide: number;
  private readonly maxSpeed: number;
  private readonly radius: number;
  private readonly idleDelay: number;

  // All steering state preallocated; update() never allocates.
  private readonly vel = new THREE.Vector3(); // y unused — planar steering
  private readonly slot = new THREE.Vector3(); // smoothed slot (x,z)
  private readonly lastPos = new THREE.Vector3();
  private readonly leaderPrev = new THREE.Vector3();
  private readonly lookPoint = new THREE.Vector3();

  private leaderIdleTime = 0;
  private glanceTimer = 0;
  private lookActive = false;
  private lookAtLeader = true;
  private sitting = false;
  /** Snap (not ease) to ground on the first update after spawn/warp. */
  private snapGround = true;

  constructor(actor: FollowableActor, opts: FollowerOptions) {
    this.actor = actor;
    this.offsetBack = opts.offsetBack;
    this.offsetSide = opts.offsetSide;
    this.maxSpeed = opts.maxSpeed;
    this.radius = opts.radius;
    this.idleDelay = opts.idleDelay ?? 3;
  }

  /** Teleport the follower to its slot (scene spawn). */
  warpToSlot(leaderPos: THREE.Vector3, leaderYaw: number): void {
    const sinY = Math.sin(leaderYaw);
    const cosY = Math.cos(leaderYaw);
    // slot = leader − forward·back + right·side; forward=(sin,0,cos), right=(−cos,0,sin).
    this.position.set(
      leaderPos.x - sinY * this.offsetBack - cosY * this.offsetSide,
      leaderPos.y,
      leaderPos.z - cosY * this.offsetBack + sinY * this.offsetSide,
    );
    this.slot.copy(this.position);
    this.lastPos.copy(this.position);
    this.leaderPrev.copy(leaderPos);
    this.vel.set(0, 0, 0);
    this.heading = leaderYaw;
    this.leaderIdleTime = 0;
    this.glanceTimer = 0;
    this.lookActive = false;
    if (this.sitting) {
      this.actor.stand?.();
      this.sitting = false;
    }
    this.snapGround = true;
    this.actor.group.position.copy(this.position);
    this.actor.group.rotation.y = leaderYaw; // no visible lerp from origin
    this.actor.setLocomotion(0, leaderYaw);
  }

  update(
    dt: number,
    elapsed: number,
    leaderPos: THREE.Vector3,
    leaderYaw: number,
    colliders: ColliderWorld,
    /** Other followers' positions for separation (may include self; skip it). */
    others: ReadonlyArray<THREE.Vector3>,
  ): void {
    const pos = this.position;
    const vel = this.vel;

    // ---- 1. slot: instantaneous, then ease the slot itself (~3 Hz) so
    // leader turns whip the followers less ----
    const sinY = Math.sin(leaderYaw);
    const cosY = Math.cos(leaderYaw);
    const slotX = leaderPos.x - sinY * this.offsetBack - cosY * this.offsetSide;
    const slotZ = leaderPos.z - cosY * this.offsetBack + sinY * this.offsetSide;
    const slotK = Math.min(1, SLOT_EASE_RATE * dt);
    this.slot.x += (slotX - this.slot.x) * slotK;
    this.slot.z += (slotZ - this.slot.z) * slotK;

    // ---- 2. arrive: ease velocity toward dir·desiredSpeed at ≤ ACCEL ----
    let toX = this.slot.x - pos.x;
    let toZ = this.slot.z - pos.z;
    const dist = Math.hypot(toX, toZ);
    let desired = this.maxSpeed * Math.min(1, Math.max(0, (dist - ARRIVE_DEAD) / ARRIVE_RANGE));
    if (dist > CATCHUP_DIST) desired = this.maxSpeed * CATCHUP_MULT;
    if (dist > 1e-5) {
      toX /= dist;
      toZ /= dist;
    } else {
      toX = 0;
      toZ = 0;
    }
    const dvX = toX * desired - vel.x;
    const dvZ = toZ * desired - vel.z;
    const dvLen = Math.hypot(dvX, dvZ);
    if (dvLen > 1e-6) {
      const step = Math.min(dvLen, ACCEL * dt) / dvLen;
      vel.x += dvX * step;
      vel.z += dvZ * step;
    }

    // ---- 3. separation: other followers + leader heel clearance ----
    const sepRange = this.radius + SEP_PAD;
    for (let i = 0; i < others.length; i++) {
      const o = others[i]!;
      if (o === pos) continue; // self by identity
      const sx = pos.x - o.x;
      const sz = pos.z - o.z;
      const d2 = sx * sx + sz * sz;
      if (d2 >= sepRange * sepRange || d2 < 1e-8) continue; // 1e-8: self by value
      const d = Math.sqrt(d2);
      const w = ((sepRange - d) * SEP_ACCEL * dt) / d; // weight ∝ overlap
      vel.x += sx * w;
      vel.z += sz * w;
    }
    const hx = pos.x - leaderPos.x;
    const hz = pos.z - leaderPos.z;
    const hd2 = hx * hx + hz * hz;
    if (hd2 < LEADER_CLEARANCE * LEADER_CLEARANCE && hd2 > 1e-8) {
      const hd = Math.sqrt(hd2);
      const w = ((LEADER_CLEARANCE - hd) * SEP_ACCEL * dt) / hd;
      vel.x += hx * w;
      vel.z += hz * w;
    }
    const speedCap = this.maxSpeed * CATCHUP_MULT;
    const v2 = vel.x * vel.x + vel.z * vel.z;
    if (v2 > speedCap * speedCap) {
      const s = speedCap / Math.sqrt(v2);
      vel.x *= s;
      vel.z *= s;
    }

    // ---- 4. integrate + collide + ground ----
    pos.x += vel.x * dt;
    pos.z += vel.z * dt;
    _resolve.x = pos.x;
    _resolve.z = pos.z;
    colliders.resolveCircle(_resolve, this.radius, pos.y);
    pos.x = _resolve.x;
    pos.z = _resolve.z;
    const ground = colliders.heightAt(pos.x, pos.z);
    if (this.snapGround) {
      pos.y = ground;
      this.snapGround = false;
    } else {
      pos.y += (ground - pos.y) * Math.min(1, GROUND_EASE_RATE * dt);
    }

    // ---- 5. drive the actor: speed from actual displacement (gait phase
    // is distance-driven, so collision slides must not pump the legs) ----
    const movedX = pos.x - this.lastPos.x;
    const movedZ = pos.z - this.lastPos.z;
    const actualSpeed = dt > 1e-5 ? Math.hypot(movedX, movedZ) / dt : 0;
    this.lastPos.copy(pos);
    if (actualSpeed > MOVE_SPEED_EPS && v2 > 1e-6) {
      this.heading = Math.atan2(vel.x, vel.z); // never atan2(0,0)
    } else {
      this.heading = dampAngle(this.heading, leaderYaw, IDLE_TURN_RATE, dt);
    }
    this.actor.group.position.copy(pos);
    this.actor.setLocomotion(actualSpeed, this.heading);

    // ---- 6. idle behaviours: leader-stationary detection (speed-based so
    // it is framerate-independent; spec's 0.05 m/frame ≈ 0.3 m/s) ----
    const leaderMovedX = leaderPos.x - this.leaderPrev.x;
    const leaderMovedZ = leaderPos.z - this.leaderPrev.z;
    const leaderSpeed = dt > 1e-5 ? Math.hypot(leaderMovedX, leaderMovedZ) / dt : 0;
    this.leaderPrev.copy(leaderPos);

    if (leaderSpeed > LEADER_MOVING_SPEED) {
      this.leaderIdleTime = 0;
      if (this.sitting) {
        this.actor.stand?.(); // the moment the leader moves
        this.sitting = false;
      }
      if (this.lookActive) {
        this.actor.lookAt?.(null);
        this.lookActive = false;
      }
    } else {
      this.leaderIdleTime += dt;
      if (this.leaderIdleTime >= this.idleDelay) {
        if (this.actor.lookAt) {
          this.glanceTimer -= dt;
          if (this.glanceTimer <= 0 || !this.lookActive) {
            // Re-pick every ~4 s: leader 60% / random street point 40%.
            this.glanceTimer = GLANCE_PERIOD * (0.75 + Math.random() * 0.5);
            this.lookAtLeader = Math.random() < 0.6;
            if (!this.lookAtLeader) {
              const a = Math.random() * Math.PI * 2;
              const r = 4 + Math.random() * 8;
              this.lookPoint.set(pos.x + Math.sin(a) * r, pos.y + 1.5, pos.z + Math.cos(a) * r);
            }
            this.lookActive = true;
          }
          if (this.lookAtLeader) {
            this.lookPoint.set(leaderPos.x, leaderPos.y + 1.6, leaderPos.z);
          }
          this.actor.lookAt(this.lookPoint);
        }
        if (
          this.actor.sit !== undefined &&
          !this.sitting &&
          this.leaderIdleTime >= this.idleDelay * SIT_DELAY_MULT
        ) {
          this.actor.sit();
          this.sitting = true;
        }
      }
    }

    this.actor.update(dt, elapsed);
  }
}

/** Shortest-arc exponential angle damping (same convention as player.ts). */
function dampAngle(current: number, target: number, rate: number, dt: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * Math.min(1, rate * dt);
}
