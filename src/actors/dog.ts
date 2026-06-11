import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchWorldMaterial } from '../graphics/worldMaterial';

/**
 * Birk (§3.2, §4.5): grey-muzzled hunting dog, Tier-B procedural quadruped.
 * Segmented rig: body (chest+rump), neck→head with EARS (two bones — Birk
 * acts with his ears), tail bone, four two-segment legs. Trot cycle:
 * diagonal leg pairs, phase from distance travelled (no foot-slide), body
 * pitch/roll micro-motion, tail sway; idle = sniffing head bob, occasional
 * sit. The alert pose is the game's danger UI: ears up, body frozen toward
 * the target, low growl handled by audio later (M3).
 *
 * CONTRACT (frozen):
 * - group origin at the FEET (ground), faces local +Z, shoulder height ~0.55 m.
 * - setLocomotion(speed, yaw) before update() each frame; trot from ~1.2 m/s,
 *   walk below. The actor lags its rotation toward yaw.
 * - alert(target): enter alert stance toward world point (ears up, tail
 *   stiff, head fixed on target — overrides look); alert(null) relaxes.
 * - sit()/stand(): idle posture toggle (followers use it when waiting long).
 * - update(dt, elapsed): zero allocations.
 */
export interface DogParams {
  furColor?: string;
  muzzleColor?: string;
  ashAmount?: number;
  seed?: number;
}

// ---------------------------------------------------------------------------
// Build dimensions (metres). Shoulder (withers) ≈ 0.55, nose→rump ≈ 0.95.
// ---------------------------------------------------------------------------
const BODY_H = 0.42; // chest pivot height (torso top ≈ 0.56)
const BODY_Z = 0.14; // chest pivot forward of group origin
const NECK_LEN = 0.2;
const NECK_RAKE = 0.9; // rad forward from vertical — pointer carriage
const HEAD_REST_X = -0.78; // counter-rotation: muzzle level-ish, nose 0.12 down

const FRONT_UPPER = 0.19;
const FRONT_LOWER = 0.19;
const HIND_UPPER = 0.19;
const HIND_LOWER = 0.21;
// Rest angles solved so paws land at y≈0 under their pivots (hock back).
const FRONT_REST = 0.05;
const FRONT_KNEE_REST = -0.1;
const HIND_REST = 0.5;
const HIND_KNEE_REST = -0.93;

// ---------------------------------------------------------------------------
// Gait (§dog spec): lateral-sequence walk below 1.1 m/s, diagonal trot above,
// blended over a 0.2 m/s band. Phase offsets in cycles, leg order
// [LF, RF, LH, RH]. The walk→trot lerp keeps L/R pairs 180° apart throughout
// so the transition never collapses into a pace.
// ---------------------------------------------------------------------------
const WALK_OFF = [0.25, 0.75, 0.0, 0.5];
const TROT_OFF = [0.0, 0.5, 0.5, 1.0];
const WALK_STRIDE = 0.5;
const TROT_STRIDE = 0.8;
const TROT_LO = 1.0; // blend band: walk below 1.0, full trot at 1.2
const TROT_HI = 1.2;
const WALK_AMP = 0.35; // ±20°
const TROT_AMP = 0.56; // ±32°
const TURN_RATE = 14; // rad/s — dogs turn quicker than people
const SIT_PITCH = 0.44; // ~25° nose-up around the chest pivot → rump drops

const SNIFF_DUR = 1.8;
const WAG_DUR = 1.4;

// Module-scope scratch — update() allocates nothing.
const _v = new THREE.Vector3();

interface LegRig {
  pivot: THREE.Group;
  knee: THREE.Group;
  rest: number;
  kneeRest: number;
  /** Carpus/hock fold amplitude during swing. */
  fold: number;
  hind: boolean;
}

export class DogActor {
  readonly group = new THREE.Group();

  private readonly furMat: THREE.MeshStandardMaterial;
  private readonly muzzleMat: THREE.MeshStandardMaterial;
  private readonly earMat: THREE.MeshStandardMaterial;

  private readonly body = new THREE.Group();
  private readonly torsoMesh: THREE.Mesh;
  private readonly neck = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly earPivots: [THREE.Group, THREE.Group];
  private readonly tail1 = new THREE.Group();
  private readonly tail2 = new THREE.Group();
  private readonly legs: LegRig[] = [];

  // Locomotion state
  private targetSpeed = 0;
  private targetYaw = 0;
  private smoothSpeed = 0;
  private gaitPhase = 0;
  private idleBlend = 1;

  // Behaviour state
  private alertActive = false;
  private readonly alertTarget = new THREE.Vector3();
  private alertBlend = 0;
  private sitting = false;
  private sitBlend = 0;

  // Head smoothing (look-at / sniff arrive softly)
  private neckX = NECK_RAKE;
  private neckY = 0;
  private headX = HEAD_REST_X;
  private headY = 0;

  // Idle schedulers (sniff dips, tail wag episodes)
  private sniffT = -1;
  private sniffCooldown = 2.0;
  private wagT = -1;
  private wagCooldown = 3.0;
  private readonly rng: () => number;
  private readonly earJitter: [number, number];

  constructor(params: DogParams = {}) {
    this.rng = mulberry32(params.seed ?? 7);
    const rng = this.rng;
    this.earJitter = [(rng() - 0.5) * 0.12, (rng() - 0.5) * 0.12];

    // ---- materials (every surface through patchWorldMaterial: ash settles
    // on his back and shoulders, ~0.5 by default) ----
    const ash = params.ashAmount ?? 0.5;
    this.furMat = new THREE.MeshStandardMaterial({
      color: params.furColor ?? '#6b665e',
      roughness: 0.95,
    });
    this.furMat.color.offsetHSL(0, 0, (rng() - 0.5) * 0.04);
    this.muzzleMat = new THREE.MeshStandardMaterial({
      color: params.muzzleColor ?? '#9a958c',
      roughness: 0.92,
    });
    this.earMat = new THREE.MeshStandardMaterial({
      color: this.furMat.color.clone().multiplyScalar(0.85),
      roughness: 0.95,
      side: THREE.DoubleSide,
    });
    patchWorldMaterial(this.furMat, { ashAmount: ash });
    patchWorldMaterial(this.muzzleMat, { ashAmount: ash * 0.7 });
    patchWorldMaterial(this.earMat, { ashAmount: ash * 0.8 });

    // ---- body: chest box-capsule + slightly lower/narrower rump, merged
    // into one fur mesh; pivot at the chest so the sit pitch drops the rump ----
    const chest = new THREE.CapsuleGeometry(0.13, 0.2, 3, 8);
    chest.rotateX(Math.PI / 2);
    chest.scale(0.86, 1, 1);
    chest.translate(0, 0.01, 0.04);
    const rump = new THREE.CapsuleGeometry(0.105, 0.16, 3, 8);
    rump.rotateX(Math.PI / 2);
    rump.scale(0.88, 0.95, 1);
    rump.translate(0, -0.035, -0.3);
    this.torsoMesh = this.makeMesh(mergeGeometries([chest, rump]), this.furMat);
    chest.dispose();
    rump.dispose();
    this.torsoMesh.receiveShadow = true;
    this.body.add(this.torsoMesh);
    this.body.position.set(0, BODY_H, BODY_Z);
    this.group.add(this.body);

    // Pale chest patch (second mesh in muzzleColor — the pointer blaze).
    const patchGeo = new THREE.SphereGeometry(0.07, 7, 5);
    patchGeo.scale(0.85, 1.0, 0.5);
    patchGeo.translate(0, -0.05, 0.21);
    this.torsoMesh.add(this.makeMesh(patchGeo, this.muzzleMat));

    // ---- neck (raked forward) → head (wedge muzzle, grey-tinted front) ----
    const neckGeo = new THREE.CylinderGeometry(0.055, 0.075, NECK_LEN, 7);
    neckGeo.translate(0, NECK_LEN / 2, 0);
    this.neck.add(this.makeMesh(neckGeo, this.furMat));
    this.neck.position.set(0, 0.09, 0.17);
    this.neck.rotation.x = NECK_RAKE;
    this.body.add(this.neck);

    const skull = new THREE.SphereGeometry(0.062, 8, 6);
    skull.scale(0.95, 0.9, 1.15);
    skull.translate(0, 0.01, 0);
    const muzzle = new THREE.BoxGeometry(0.075, 0.06, 0.13, 1, 1, 2);
    taperFront(muzzle, 0.03, 0.6, 0.62, -0.008);
    muzzle.translate(0, -0.012, 0.115);
    this.head.add(this.makeMesh(mergeGeometries([skull, muzzle]), this.furMat));
    skull.dispose();
    muzzle.dispose();
    const tip = new THREE.BoxGeometry(0.05, 0.045, 0.055, 1, 1, 1);
    taperFront(tip, 0, 0.8, 0.8, 0);
    tip.translate(0, -0.012, 0.185);
    this.head.add(this.makeMesh(tip, this.muzzleMat));
    this.head.position.set(0, NECK_LEN, 0);
    this.head.rotation.x = HEAD_REST_X;
    this.neck.add(this.head);

    // ---- ears: separate bones, flat rounded triangles pivoting at the base.
    // earPivots[0] = left (+X). The whole danger read lives in these two. ----
    const earGeo = makeEarGeometry();
    this.earPivots = [new THREE.Group(), new THREE.Group()];
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const pivot = this.earPivots[i];
      pivot.position.set(side * 0.055, 0.045, -0.01);
      pivot.rotation.y = side * 0.35; // base splay so the flats catch light
      pivot.add(this.makeMesh(i === 0 ? earGeo : earGeo.clone(), this.earMat));
      this.head.add(pivot);
    }

    // ---- tail: two segments, pivot at the rump ----
    const t1 = new THREE.CylinderGeometry(0.018, 0.024, 0.16, 5);
    t1.translate(0, 0.08, 0);
    this.tail1.add(this.makeMesh(t1, this.furMat));
    this.tail1.position.set(0, 0.0, -0.45);
    this.tail1.rotation.x = -2.35;
    this.body.add(this.tail1);
    const t2 = new THREE.CylinderGeometry(0.01, 0.017, 0.15, 5);
    t2.translate(0, 0.075, 0);
    this.tail2.add(this.makeMesh(t2, this.furMat));
    this.tail2.position.set(0, 0.16, 0);
    this.tail2.rotation.x = -0.35;
    this.tail1.add(this.tail2);

    // ---- legs: front straighter, hind angled with the hock set back ----
    this.legs.push(
      this.makeLeg(0.082, -0.04, 0.12, false), // LF
      this.makeLeg(-0.082, -0.04, 0.12, false), // RF
      this.makeLeg(0.078, -0.06, -0.36, true), // LH
      this.makeLeg(-0.078, -0.06, -0.36, true), // RH
    );
  }

  /** Planar speed (m/s) + world heading; call every frame before update(). */
  setLocomotion(speed: number, yaw: number): void {
    this.targetSpeed = speed;
    this.targetYaw = yaw;
  }

  /** Alert stance toward a world point; null relaxes over ~0.5 s. */
  alert(target: THREE.Vector3 | null): void {
    if (target) {
      this.alertTarget.copy(target);
      this.alertActive = true;
    } else {
      this.alertActive = false;
    }
  }

  sit(): void {
    this.sitting = true;
  }

  stand(): void {
    this.sitting = false;
  }

  update(dt: number, elapsed: number): void {
    // ---- behaviour blends (alert snaps in, relaxes over ~0.5 s; sit 0.4 s) ----
    const aRate = this.alertActive ? 6 : 2;
    this.alertBlend = approach(this.alertBlend, this.alertActive ? 1 : 0, aRate, dt);
    this.sitBlend = approach(this.sitBlend, this.sitting ? 1 : 0, 2.5, dt);
    const aB = this.alertBlend;
    const sB = this.sitBlend * (1 - aB); // alert stance wins over sit

    // ---- heading: eased like the humanoid, but quicker (14 rad/s) ----
    this.group.rotation.y = dampAngle(this.group.rotation.y, this.targetYaw, TURN_RATE, dt);

    // ---- gait phase from DISTANCE travelled — no paw-slide ----
    this.smoothSpeed += (this.targetSpeed - this.smoothSpeed) * Math.min(1, 6 * dt);
    const trot = smoothstep(TROT_LO, TROT_HI, this.smoothSpeed);
    const stride = WALK_STRIDE + (TROT_STRIDE - WALK_STRIDE) * trot;
    this.gaitPhase = (this.gaitPhase + (this.targetSpeed * dt) / stride) % 1;
    const idleTarget = this.targetSpeed < 0.05 ? 1 : 0;
    this.idleBlend = approach(this.idleBlend, idleTarget, 5, dt);
    const idle = this.idleBlend;

    const moveW = (1 - idle) * (1 - sB) * (1 - aB); // gait weight (alert freezes it)
    const ampNorm = Math.min(1, this.smoothSpeed / 0.5) * moveW;
    const amp = (WALK_AMP + (TROT_AMP - WALK_AMP) * trot) * ampNorm;
    const theta = this.gaitPhase * Math.PI * 2;

    // ---- idle schedulers: sniff dips + wag episodes ----
    if (this.sniffT < 0) {
      if (idle > 0.5 && aB < 0.3) {
        this.sniffCooldown -= dt;
        if (this.sniffCooldown <= 0) this.sniffT = 0;
      }
    } else {
      this.sniffT += dt / SNIFF_DUR;
      if (this.sniffT >= 1) {
        this.sniffT = -1;
        this.sniffCooldown = 2.5 + this.rng() * 3.5;
      }
    }
    if (this.wagT < 0) {
      if (idle > 0.5 && aB < 0.3) {
        this.wagCooldown -= dt;
        if (this.wagCooldown <= 0) this.wagT = 0;
      }
    } else {
      this.wagT += dt / WAG_DUR;
      if (this.wagT >= 1) {
        this.wagT = -1;
        this.wagCooldown = 4 + this.rng() * 5;
      }
    }
    // Sniff envelope with a nose-jitter ripple while the nose is down.
    let dip = this.sniffT >= 0 ? Math.sin(Math.PI * Math.min(1, this.sniffT)) : 0;
    dip *= (1 + 0.08 * Math.sin(elapsed * 22)) * idle * (1 - aB) * (1 - sB * 0.5);
    const wag = this.wagT >= 0 ? Math.sin(Math.PI * Math.min(1, this.wagT)) : 0;

    // ---- legs ----
    for (let i = 0; i < 4; i++) {
      const leg = this.legs[i];
      const off = WALK_OFF[i] + (TROT_OFF[i] - WALK_OFF[i]) * trot;
      const th = theta + off * Math.PI * 2;
      let upper = leg.rest + amp * Math.sin(th);
      // Carpus/hock folds while the leg swings forward (foot off the ground).
      let knee = leg.kneeRest - leg.fold * Math.max(0, Math.cos(th)) * ampNorm * (0.6 + 0.5 * trot);
      // Sit: hind legs fold under, front legs stay straight (counter the
      // body pitch so they read vertical), rump already dropped by the pivot.
      const upperSit = leg.hind ? 1.25 : leg.rest + SIT_PITCH;
      const kneeSit = leg.hind ? -2.1 : -0.04;
      upper = upper + (upperSit - upper) * sB;
      knee = knee + (kneeSit - knee) * sB;
      // Alert: stiff stance, weight forward, hind stretched a touch back.
      const upperAlert = leg.rest - (leg.hind ? 0.12 : 0.06);
      const kneeAlert = leg.kneeRest - (leg.hind ? 0.05 : 0);
      leg.pivot.rotation.x = upper + (upperAlert - upper) * aB;
      leg.knee.rotation.x = knee + (kneeAlert - knee) * aB;
    }

    // ---- body micro-motion: walk roll 1/stride, trot pitch+bob 2/stride ----
    const bob = (0.006 + (0.016 - 0.006) * trot) * Math.sin(2 * theta) * ampNorm;
    let bodyPitch = trot * 0.03 * Math.sin(2 * theta + 0.8) * ampNorm;
    const bodyRoll = (1 - trot) * 0.035 * Math.sin(theta) * ampNorm;
    let bodyY = BODY_H + bob;
    let bodyZ = BODY_Z;
    // Sit: nose-up pitch around the chest — the rump drops with the pivot.
    bodyPitch = bodyPitch + (-SIT_PITCH - bodyPitch) * sB;
    bodyY += -0.05 * sB;
    bodyZ += -0.02 * sB;
    // Alert: frozen, chest dipped — weight over the front legs.
    bodyPitch = bodyPitch + (0.06 - bodyPitch) * aB;
    bodyY += -0.012 * aB;
    bodyZ += 0.03 * aB;
    this.body.position.y = bodyY;
    this.body.position.z = bodyZ;
    this.body.rotation.x = bodyPitch;
    this.body.rotation.z = bodyRoll;
    // Breathing: 0.5 Hz, ±1% torso height, idle only (legs are siblings of
    // the torso mesh so the scale never stretches them).
    this.torsoMesh.scale.y = 1 + 0.01 * Math.sin(elapsed * Math.PI) * idle;

    // ---- head: gait bob / sniff dip, or LOCKED on the alert target ----
    let neckXT =
      NECK_RAKE -
      0.1 * idle +
      (0.045 * (1 - trot) * Math.sin(theta + 1.4) + 0.03 * trot * Math.sin(2 * theta + 1.4)) *
        ampNorm +
      dip * 0.95;
    let headXT = HEAD_REST_X + dip * 0.5;
    let neckYT = 0;
    let headYT = dip * 0.22 * Math.sin(elapsed * 1.7);
    if (aB > 0.001) {
      // Local-frame direction to the target from the approximate head pivot.
      const gy = this.group.rotation.y;
      _v.set(
        this.alertTarget.x - (this.group.position.x + Math.sin(gy) * 0.45),
        this.alertTarget.y - (this.group.position.y + 0.63),
        this.alertTarget.z - (this.group.position.z + Math.cos(gy) * 0.45),
      );
      const hDist = Math.max(1e-3, Math.hypot(_v.x, _v.z));
      const ly = clamp(wrapAngle(Math.atan2(_v.x, _v.z) - gy), -1.25, 1.25);
      const lp = clamp(Math.atan2(_v.y, hDist), -0.6, 0.55);
      // Split look across neck+head; sum of pitches = -lp (world muzzle pitch).
      neckXT = neckXT + (0.62 - lp * 0.45 - neckXT) * aB;
      headXT = headXT + (-0.62 - lp * 0.55 - headXT) * aB;
      neckYT = neckYT + (ly * 0.45 - neckYT) * aB;
      headYT = headYT + (ly * 0.55 - headYT) * aB;
    }
    // Damped arrival — alert locks fast, sniff dips land softly.
    const headRate = Math.min(1, (8 + 8 * aB) * dt);
    this.neckX += (neckXT - this.neckX) * headRate;
    this.neckY += (neckYT - this.neckY) * headRate;
    this.headX += (headXT - this.headX) * headRate;
    this.headY += (headYT - this.headY) * headRate;
    this.neck.rotation.x = this.neckX;
    this.neck.rotation.y = this.neckY;
    this.head.rotation.x = this.headX;
    this.head.rotation.y = this.headY;

    // ---- EARS — the signature read. Relaxed droop outward (half-relaxed at
    // idle), tiny flop with the gait; alert rotates BOTH forward and up. ----
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1; // droop sign: left ear (+X) tips outward
      const droop =
        0.95 - 0.23 * idle + this.earJitter[i] + 0.06 * Math.sin(2 * theta + i * 2.4) * ampNorm;
      const ear = this.earPivots[i];
      ear.rotation.z = side * (droop + (0.12 - droop) * aB);
      ear.rotation.x = -0.18 + (0.52 - -0.18) * aB;
    }

    // ---- tail: relaxed sway walking, streams a little at trot, occasional
    // idle wag; sit curls it; alert holds it straight and STILL ----
    let tail1X = -2.35 + 0.3 * trot;
    let tail1Z =
      (0.25 * (1 - trot) * Math.sin(theta + 0.5) + 0.1 * trot * Math.sin(2 * theta)) * ampNorm +
      wag * 0.45 * Math.sin(elapsed * 9) * idle;
    let tail2X = -0.35;
    tail1X = tail1X + (-2.75 - tail1X) * sB;
    tail1Z = tail1Z + (0.55 - tail1Z) * sB;
    tail2X = tail2X + (-0.5 - tail2X) * sB;
    this.tail1.rotation.x = tail1X + (-1.7 - tail1X) * aB;
    this.tail1.rotation.z = tail1Z * (1 - aB);
    this.tail2.rotation.x = tail2X + (-0.05 - tail2X) * aB;
    this.tail2.rotation.z = tail1Z * 0.8 * (1 - aB);
  }

  dispose(): void {
    this.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) (obj as THREE.Mesh).geometry.dispose();
    });
    this.furMat.dispose();
    this.muzzleMat.dispose();
    this.earMat.dispose();
  }

  // -------------------------------------------------------------------------

  private makeMesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    return mesh;
  }

  /** Two-segment leg: shoulder/hip pivot → knee/hock → lower leg + paw. */
  private makeLeg(x: number, y: number, z: number, hind: boolean): LegRig {
    const upperLen = hind ? HIND_UPPER : FRONT_UPPER;
    const lowerLen = hind ? HIND_LOWER : FRONT_LOWER;
    const upperR = hind ? 0.045 : 0.034;

    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    const upperGeo = new THREE.CylinderGeometry(upperR, upperR * 0.6, upperLen, 6);
    upperGeo.translate(0, -upperLen / 2, 0);
    if (hind) upperGeo.scale(0.8, 1, 1.25); // flattened, meaty thigh
    pivot.add(this.makeMesh(upperGeo, this.furMat));

    const knee = new THREE.Group();
    knee.position.set(0, -upperLen, 0);
    const lowerGeo = new THREE.CylinderGeometry(0.022, 0.016, lowerLen, 5);
    lowerGeo.translate(0, -lowerLen / 2, 0);
    const pawGeo = new THREE.BoxGeometry(0.055, 0.04, 0.085, 1, 1, 1);
    taperFront(pawGeo, 0, 0.75, 0.7, 0);
    pawGeo.translate(0, -lowerLen + 0.018, 0.02);
    knee.add(this.makeMesh(mergeGeometries([lowerGeo, pawGeo]), this.furMat));
    lowerGeo.dispose();
    pawGeo.dispose();
    pivot.add(knee);
    this.body.add(pivot);

    const rest = hind ? HIND_REST : FRONT_REST;
    const kneeRest = hind ? HIND_KNEE_REST : FRONT_KNEE_REST;
    pivot.rotation.x = rest;
    knee.rotation.x = kneeRest;
    return { pivot, knee, rest, kneeRest, fold: hind ? 0.7 : 0.55, hind };
  }
}

// ---------------------------------------------------------------------------
// Geometry + math helpers (build-time only; update() touches none of these
// except the pure number functions).
// ---------------------------------------------------------------------------

/** Flat rounded-triangle ear, base at the origin, tip up local +Y. */
function makeEarGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.032, 0);
  shape.lineTo(0.032, 0);
  shape.quadraticCurveTo(0.044, 0.055, 0.004, 0.1);
  shape.quadraticCurveTo(-0.044, 0.055, -0.032, 0);
  return new THREE.ShapeGeometry(shape, 5);
}

/** Scale +Z-side vertices in (wedge muzzle, tapered paw); fixes normals. */
function taperFront(geo: THREE.BufferGeometry, zFrom: number, sx: number, sy: number, dy: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getZ(i) > zFrom) {
      pos.setXY(i, pos.getX(i) * sx, pos.getY(i) * sy + dy);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Linear approach with rate 1/seconds — frame-rate independent enough here. */
function approach(current: number, target: number, rate: number, dt: number): number {
  const step = rate * dt;
  if (current < target) return Math.min(target, current + step);
  return Math.max(target, current - step);
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Shortest-arc exponential angle damping (matches player.ts convention). */
function dampAngle(current: number, target: number, rate: number, dt: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * Math.min(1, rate * dt);
}
