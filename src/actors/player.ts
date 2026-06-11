import * as THREE from 'three';
import type { Input } from '../core/input';
import type { ColliderWorld } from '../world/collision';
import type { HumanoidActor } from './humanoid';
import { dampAngle } from '../core/math';

/**
 * Third-person player controller (§4.2): WASD relative to the camera,
 * mouse orbit, over-shoulder framing at ~1.7 m, 50° FOV. Shift is a brisk
 * walk — there is no sprint; the pacing is deliberate. Movement resolves
 * against ColliderWorld (circle capsule footprint + sampled ground height).
 *
 * The camera is a damped orbit boom behind the right shoulder; it pulls in
 * when world boxes intersect the boom so walls never split the frame.
 */

const WALK_SPEED = 1.6;
const BRISK_SPEED = 2.7;
const ACCEL = 8;
const TURN_RATE = 10; // rad/s toward move heading
const PLAYER_RADIUS = 0.32;

const BOOM_LENGTH = 3.4;
const BOOM_MIN = 0.9;
const SHOULDER = 0.45;
const EYE_HEIGHT = 1.62;

const _mouse = { x: 0, y: 0 };
const _moveDir = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _boomDir = new THREE.Vector3();
const _resolve = { x: 0, z: 0 };
const _probe = { x: 0, z: 0 };

export class PlayerController {
  /** World position at the feet. */
  readonly position = new THREE.Vector3();
  /** Facing of the character (world yaw, rad). */
  heading = Math.PI;
  /** Camera orbit angles. */
  camYaw = Math.PI;
  camPitch = -0.06;

  enabled = true;
  lookSensitivity = 0.0021;

  private speed = 0;

  constructor(
    private actor: HumanoidActor,
    private camera: THREE.PerspectiveCamera,
    private input: Input,
    private colliders: ColliderWorld,
  ) {}

  spawn(x: number, z: number, yaw: number): void {
    this.position.set(x, this.colliders.heightAt(x, z), z);
    this.heading = yaw;
    this.camYaw = yaw;
    this.actor.group.position.copy(this.position);
    this.actor.group.rotation.y = yaw;
    this.snapCamera();
  }

  update(dt: number, elapsed: number): void {
    if (!this.enabled) {
      this.actor.setLocomotion(0, this.heading);
      this.actor.update(dt, elapsed);
      return;
    }

    // ---- camera orbit from mouse ----
    this.input.consumeMouseDelta(_mouse);
    this.camYaw -= _mouse.x * this.lookSensitivity;
    this.camPitch -= _mouse.y * this.lookSensitivity;
    this.camPitch = Math.max(-0.9, Math.min(0.55, this.camPitch));

    // ---- movement intent, camera-relative ----
    let ix = 0;
    let iz = 0;
    if (this.input.pressed('KeyW')) iz += 1;
    if (this.input.pressed('KeyS')) iz -= 1;
    if (this.input.pressed('KeyD')) ix += 1;
    if (this.input.pressed('KeyA')) ix -= 1;
    const wantsMove = ix !== 0 || iz !== 0;

    const targetSpeed = wantsMove
      ? this.input.pressed('ShiftLeft') || this.input.pressed('ShiftRight')
        ? BRISK_SPEED
        : WALK_SPEED
      : 0;
    this.speed += (targetSpeed - this.speed) * Math.min(1, ACCEL * dt);
    if (this.speed < 0.02) this.speed = 0;

    if (wantsMove) {
      // Yaw convention everywhere: facing = (sin(yaw), 0, cos(yaw)).
      // Camera right = forward × up = (-cos(yaw), 0, sin(yaw)).
      const len = Math.hypot(ix, iz);
      const sin = Math.sin(this.camYaw);
      const cos = Math.cos(this.camYaw);
      _moveDir.set((sin * iz - cos * ix) / len, 0, (cos * iz + sin * ix) / len);
      const targetHeading = Math.atan2(_moveDir.x, _moveDir.z);
      this.heading = dampAngle(this.heading, targetHeading, TURN_RATE, dt);
    }

    // ---- integrate + collide ----
    if (this.speed > 0) {
      this.position.x += Math.sin(this.heading) * this.speed * dt;
      this.position.z += Math.cos(this.heading) * this.speed * dt;
      _resolve.x = this.position.x;
      _resolve.z = this.position.z;
      this.colliders.resolveCircle(_resolve, PLAYER_RADIUS, this.position.y);
      this.position.x = _resolve.x;
      this.position.z = _resolve.z;
    }
    const ground = this.colliders.heightAt(this.position.x, this.position.z);
    // Soft step-up/down (curbs, thresholds).
    this.position.y += (ground - this.position.y) * Math.min(1, 12 * dt);

    // ---- drive the visible character ----
    this.actor.group.position.copy(this.position);
    this.actor.setLocomotion(this.speed, this.heading);
    this.actor.update(dt, elapsed);

    this.updateCamera(dt);
  }

  private updateCamera(dt: number): void {
    void dt;
    const sinY = Math.sin(this.camYaw);
    const cosY = Math.cos(this.camYaw);
    const cosP = Math.cos(this.camPitch);
    // Look target sits a shoulder-width to camera-right of the head, so the
    // character frames slightly left — classic over-the-shoulder.
    _camTarget.set(
      this.position.x - cosY * SHOULDER,
      this.position.y + EYE_HEIGHT,
      this.position.z + sinY * SHOULDER,
    );
    // Boom from target toward the camera = -viewForward.
    _boomDir.set(-sinY * cosP, -Math.sin(this.camPitch), -cosY * cosP);

    // Pull the boom in when it would clip world boxes: sample a few points
    // along the boom and shorten to just before the first blocked sample.
    // The probe is a 0.6 m-tall sphere-ish span — NOT an actor capsule — so
    // overhead colliders (the gennemgang arch, yMin 2.3) don't falsely yank
    // the camera in when there is real clearance.
    let boom = BOOM_LENGTH;
    for (let s = 1; s <= 6; s++) {
      const t = (s / 6) * BOOM_LENGTH;
      _probe.x = _camTarget.x + _boomDir.x * t;
      _probe.z = _camTarget.z + _boomDir.z * t;
      if (this.colliders.resolveCircle(_probe, 0.3, _camTarget.y + _boomDir.y * t - 0.3, 0.6)) {
        boom = Math.max(BOOM_MIN, t - BOOM_LENGTH / 6);
        break;
      }
    }

    _camPos.copy(_camTarget).addScaledVector(_boomDir, boom);
    const groundAtCam = this.colliders.heightAt(_camPos.x, _camPos.z);
    if (_camPos.y < groundAtCam + 0.25) _camPos.y = groundAtCam + 0.25;

    this.camera.position.copy(_camPos);
    this.camera.lookAt(_camTarget);
  }

  private snapCamera(): void {
    this.updateCamera(0);
  }
}
