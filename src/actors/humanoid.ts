import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchWorldMaterial } from '../graphics/worldMaterial';
import { mulberry32, clamp, smoothstep, dampAngle } from '../core/math';

/**
 * Tier-B procedural humanoid (§6.7, §5.4): a code-built, hooded, scarfed
 * figure with procedural locomotion. No facial animation — acting is body
 * language, head look-at, and lighting.
 *
 * Build: segmented joint hierarchy (Groups as bones: hips→spine→chest→head;
 * shoulder→elbow per arm; hip→knee per leg) carrying low-poly meshes —
 * a long coat (flared lower hem), boots, gloves, hood cone, scarf band
 * covering the lower face, goggle strip. The doc's "skinned mesh" upgrade
 * arrives with Tier A assets; the segmented rig is the required Tier B and
 * must look deliberate, not broken.
 *
 * Locomotion: gait phase advances with DISTANCE TRAVELLED (phase +=
 * speed·dt / strideLength · 2π) so feet never slide. Walk cycle drives leg
 * swing, opposite arm swing, hip sway, subtle torso bob (2/step) and head
 * counter-bob; speed 0 cross-fades into idle breathing + occasional weight
 * shift. All materials go through patchWorldMaterial (ash on shoulders/hood:
 * ashAmount ≈ 0.7 — people collect the world's signature too).
 *
 * CONTRACT (frozen — player controller + followers code against this):
 * - group origin at the FEET, character faces local +Z, ~1.7 m tall scaled
 *   by params.height.
 * - setLocomotion(speed, yaw) every frame BEFORE update(): planar speed in
 *   m/s (0 = idle) and world heading; the actor itself rotates group.rotation.y
 *   toward yaw with a small lag so turns feel weighty.
 * - update(dt, elapsed) advances gait/idle and head look-at smoothing.
 *   Zero allocations.
 * - lookAt(point) aims the head (clamped ±60° yaw, ±30° pitch); null clears.
 */
export interface HumanoidParams {
  /** Total height in metres (Ellen 1.72, Jonas 1.78 lanky). */
  height?: number;
  /** 0..1 slim→broad. */
  build?: number;
  coatColor?: string;
  hoodColor?: string;
  scarfColor?: string;
  /** Ash on up-facing cloth. */
  ashAmount?: number;
  seed?: number;
  /** Small backpack + bedroll on the chest back (Jonas carries the gear). */
  pack?: boolean;
}

// ---------------------------------------------------------------------------
// Constants + module-scope scratch (ZERO per-frame allocations).
// ---------------------------------------------------------------------------

const RAD = THREE.MathUtils.degToRad;
const TWO_PI = Math.PI * 2;

const TURN_RATE = 10; // rad/s group yaw ease toward setLocomotion heading
const HEAD_RATE = 6; // rad/s head look-at ease
const ROLL_MAX = RAD(2); // roll INTO turns, capped
const LOOK_YAW_MAX = RAD(60);
const LOOK_PITCH_MAX = RAD(30);
const BOB_AMP = 0.025; // hips vertical bob, metres (2 dips / stride)
const BRISK = 2.7; // matches player BRISK_SPEED; normalises speed-scaled amps
// Stride: 0.62 · legLength · 2 with legLength 0.586·H → 1.25 m at H 1.72.
const STRIDE_PER_HEIGHT = 0.62 * 2 * 0.586;

const _look = new THREE.Vector3();

// Bone pivot heights as fractions of total height H (group origin = feet).
const HIPS_Y = 0.53;
const SPINE_Y = 0.62;
const CHEST_Y = 0.72;
const NECK_Y = 0.84;
const HEAD_Y = 0.88;
const SHOULDER_Y = 0.82;
const KNEE_Y = 0.28;
const ANKLE_Y = 0.07;
const HIP_X = 0.09;
const UPPER_ARM_LEN = 0.175;
const FOREARM_LEN = 0.155;

export class HumanoidActor {
  readonly group = new THREE.Group();

  // --- rig: Groups as bone pivots (hierarchy per contract) ---
  private readonly hips: THREE.Group;
  private readonly spine: THREE.Group;
  private readonly chest: THREE.Group;
  private readonly neck: THREE.Group;
  private readonly head: THREE.Group;
  private readonly shoulderL: THREE.Group;
  private readonly shoulderR: THREE.Group;
  private readonly elbowL: THREE.Group;
  private readonly elbowR: THREE.Group;
  private readonly hipL: THREE.Group;
  private readonly hipR: THREE.Group;
  private readonly kneeL: THREE.Group;
  private readonly kneeR: THREE.Group;
  private readonly ankleL: THREE.Group;
  private readonly ankleR: THREE.Group;

  // --- build dimensions ---
  private readonly H: number;
  private readonly strideLength: number;
  private readonly hipsBaseY: number;
  private readonly headBaseY: number;
  private readonly shoulderBaseY: number;

  // --- GPU resources owned by this instance ---
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];

  // --- locomotion state ---
  private speed = 0;
  private targetYaw = 0;
  private curYaw = 0;
  private yawInit = false;
  private hasLocomotion = false;
  private roll = 0;
  private gaitPhase: number;

  // --- look-at state (reference kept; caller may keep mutating its vector) ---
  private lookTarget: THREE.Vector3 | null = null;
  private headYaw = 0;
  private headPitch = 0;

  // --- idle state ---
  private readonly rng: () => number;
  private readonly breathSeed: number;
  private shiftTimer: number;
  private shiftSide: number;
  private shiftTarget = 0;
  private shiftCur = 0;
  private driftTimer: number;
  private driftYaw = 0;
  private driftPitch = 0;

  constructor(params: HumanoidParams = {}) {
    const H = (this.H = params.height ?? 1.72);
    const build = params.build ?? 0.5;
    const w = 0.86 + 0.28 * build; // girth factor (radii)
    // Pivot just inside the coat-barrel surface (lathe chest radius ≈
    // 0.125·H·w on X) so sleeves brush the coat instead of floating beside it.
    const shoulderHalf = H * (0.125 + 0.04 * build); // ±0.145H at build 0.5
    this.strideLength = STRIDE_PER_HEIGHT * H;

    const rng = (this.rng = mulberry32((params.seed ?? 7) * 1013 + 91));
    this.breathSeed = rng() * TWO_PI;
    this.gaitPhase = rng() * TWO_PI; // companions walk out of phase
    this.shiftTimer = 2 + rng() * 4;
    this.shiftSide = rng() < 0.5 ? -1 : 1;
    this.driftTimer = 1 + rng() * 4;

    this.group.name = 'humanoid';
    this.group.rotation.order = 'YXZ'; // yaw, then roll in the facing frame

    // ---- materials (per-instance: seeded colour jitter so actors differ) ----
    const ashRatio = (params.ashAmount ?? 0.8) / 0.8;
    const jitter = (hex: string): THREE.Color =>
      new THREE.Color(hex).offsetHSL((rng() - 0.5) * 0.02, (rng() - 0.5) * 0.05, (rng() - 0.5) * 0.06);

    // §5.4 fabric sheen: pale-grey sheen lifts cloth silhouettes out of flat grey.
    const cloth = (color: THREE.Color, roughness: number, ash: number): THREE.MeshPhysicalMaterial => {
      const m = new THREE.MeshPhysicalMaterial({ color, roughness, metalness: 0 });
      m.sheen = 0.35;
      m.sheenRoughness = 0.85;
      m.sheenColor.set('#b7babd');
      patchWorldMaterial(m, { ashAmount: ash * ashRatio });
      this.mats.push(m);
      return m;
    };

    const coatColor = jitter(params.coatColor ?? '#4a4d4f');
    const hoodColor = jitter(params.hoodColor ?? '#565349');
    const scarfColor = jitter(params.scarfColor ?? '#5a5550');
    const trouserColor = coatColor.clone().multiplyScalar(0.72);

    const coatMat = cloth(coatColor, 0.92, 0.45); // lower coat
    coatMat.side = THREE.DoubleSide; // open hem shows the inside edge-on
    const hoodMat = cloth(hoodColor, 0.9, 0.8); // hood collects the most ash
    hoodMat.side = THREE.DoubleSide;
    const shoulderMat = cloth(coatColor, 0.92, 0.8); // coat tone, hood-level ash
    const scarfMat = cloth(scarfColor, 0.95, 0.5);
    const trouserMat = cloth(trouserColor, 0.95, 0.35); // also gloves

    const bootMat = new THREE.MeshStandardMaterial({ color: '#2b2a28', roughness: 0.85, metalness: 0.05 });
    patchWorldMaterial(bootMat, { ashAmount: 0.3 * ashRatio });
    this.mats.push(bootMat);

    // Face cavity: matte near-black so the hood opening reads as shadow (no face).
    const darkMat = new THREE.MeshStandardMaterial({ color: '#0b0c0d', roughness: 1 });
    patchWorldMaterial(darkMat, { ashAmount: 0 });
    this.mats.push(darkMat);

    const goggleMat = new THREE.MeshPhysicalMaterial({ color: '#15171a', roughness: 0.25, metalness: 0.1 });
    patchWorldMaterial(goggleMat, { ashAmount: 0.1 * ashRatio });
    this.mats.push(goggleMat);

    // ---- helpers ----
    const bone = (name: string, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group => {
      const b = new THREE.Group();
      b.name = name;
      b.position.set(x, y, z);
      parent.add(b);
      return b;
    };
    const attach = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const track = (geo: THREE.BufferGeometry): THREE.BufferGeometry => {
      this.geos.push(geo);
      return geo;
    };

    // ---- bone hierarchy ----
    this.hips = bone('hips', this.group, 0, HIPS_Y * H, 0);
    this.hipsBaseY = HIPS_Y * H;
    this.spine = bone('spine', this.hips, 0, (SPINE_Y - HIPS_Y) * H, 0);
    this.chest = bone('chest', this.spine, 0, (CHEST_Y - SPINE_Y) * H, 0);
    this.neck = bone('neck', this.chest, 0, (NECK_Y - CHEST_Y) * H, 0);
    this.head = bone('head', this.neck, 0, (HEAD_Y - NECK_Y) * H, 0);
    this.head.rotation.order = 'YXZ'; // look yaw, then pitch
    this.headBaseY = (HEAD_Y - NECK_Y) * H;

    this.shoulderBaseY = (SHOULDER_Y - CHEST_Y) * H;
    this.shoulderL = bone('shoulderL', this.chest, shoulderHalf, this.shoulderBaseY, 0);
    this.shoulderR = bone('shoulderR', this.chest, -shoulderHalf, this.shoulderBaseY, 0);
    this.elbowL = bone('elbowL', this.shoulderL, 0, -UPPER_ARM_LEN * H, 0);
    this.elbowR = bone('elbowR', this.shoulderR, 0, -UPPER_ARM_LEN * H, 0);
    const wristL = bone('wristL', this.elbowL, 0, -FOREARM_LEN * H, 0);
    const wristR = bone('wristR', this.elbowR, 0, -FOREARM_LEN * H, 0);

    this.hipL = bone('hipL', this.hips, HIP_X * H, 0, 0);
    this.hipR = bone('hipR', this.hips, -HIP_X * H, 0, 0);
    this.kneeL = bone('kneeL', this.hipL, 0, -(HIPS_Y - KNEE_Y) * H, 0);
    this.kneeR = bone('kneeR', this.hipR, 0, -(HIPS_Y - KNEE_Y) * H, 0);
    this.ankleL = bone('ankleL', this.kneeL, 0, -(KNEE_Y - ANKLE_Y) * H, 0);
    this.ankleR = bone('ankleR', this.kneeR, 0, -(KNEE_Y - ANKLE_Y) * H, 0);

    // ---- coat: lathe torso flaring into an open hem below the hips ----
    // The hem covers the upper legs (hides knee imperfections, reads as heavy
    // winter cloth). Lives on the SPINE bone so hip sway/yaw swings the hem
    // and the spine carries the forward lean.
    const profile: Array<[number, number]> = [
      [0.30, 0.15], // open hem, just above the knees
      [0.40, 0.138],
      [0.50, 0.128],
      [0.585, 0.108], // belted waist
      [0.66, 0.115],
      [0.73, 0.125], // chest
      [0.79, 0.118],
      [0.835, 0.085],
      [0.855, 0.058], // collar tucks toward the neck
    ];
    const lathePts: THREE.Vector2[] = [];
    for (const [y, r] of profile) lathePts.push(new THREE.Vector2(r * H * w, y * H));
    const coatGeo = track(new THREE.LatheGeometry(lathePts, 14));
    coatGeo.scale(1, 1, 0.8); // bodies are wider than deep
    coatGeo.translate(0, -SPINE_Y * H, 0);
    attach(coatGeo, coatMat, this.spine);

    // ---- head stack (all on the head bone so it turns with look-at) ----
    // Dark core skull + short neck: the "face" is a shadowed void.
    const skull = new THREE.SphereGeometry(0.062 * H, 9, 7);
    skull.translate(0, 0.05 * H, 0.004 * H);
    const neckGeo = new THREE.CylinderGeometry(0.034 * H, 0.042 * H, 0.07 * H, 8);
    neckGeo.translate(0, -0.01 * H, 0);
    const headCore = track(mergeGeometries([skull, neckGeo], false));
    skull.dispose();
    neckGeo.dispose();
    attach(headCore, darkMat, this.head);

    // Hood: open sphere shell, gap facing +Z (the face cavity), open base.
    const hoodGeo = track(new THREE.SphereGeometry(0.088 * H, 12, 9, Math.PI / 2 + 0.85, TWO_PI - 1.7, 0, 2.25));
    hoodGeo.scale(1, 1.08, 1.15); // slightly peaked, deeper at the back
    hoodGeo.translate(0, 0.045 * H, -0.012 * H);
    attach(hoodGeo, hoodMat, this.head);

    // Scarf: squashed torus band across the lower face.
    const scarfGeo = track(new THREE.TorusGeometry(0.054 * H, 0.026 * H, 6, 12));
    scarfGeo.rotateX(Math.PI / 2);
    scarfGeo.scale(1, 1.35, 1.05);
    scarfGeo.translate(0, 0.018 * H, 0.006 * H);
    attach(scarfGeo, scarfMat, this.head);

    // Goggle strip: dark glossy band where the eyes would be (§5.4: no face).
    const goggleGeo = track(new THREE.CylinderGeometry(0.0655 * H, 0.0655 * H, 0.026 * H, 10, 1, true, -1.15, 2.3));
    goggleGeo.translate(0, 0.062 * H, 0.004 * H);
    attach(goggleGeo, goggleMat, this.head);

    // ---- arms: shoulder cap + tapered sleeve, forearm, mitten glove ----
    const cap = new THREE.SphereGeometry(0.058 * H * w, 9, 7);
    const sleeve = new THREE.CylinderGeometry(0.052 * H * w, 0.044 * H * w, UPPER_ARM_LEN * H, 8);
    sleeve.translate(0, (-UPPER_ARM_LEN / 2) * H, 0);
    const upperArmGeo = track(mergeGeometries([cap, sleeve], false));
    cap.dispose();
    sleeve.dispose();
    const forearmGeo = track(new THREE.CylinderGeometry(0.043 * H * w, 0.037 * H * w, FOREARM_LEN * H, 8));
    forearmGeo.translate(0, (-FOREARM_LEN / 2) * H, 0);
    const gloveGeo = track(new THREE.SphereGeometry(0.047 * H * w, 8, 6));
    gloveGeo.scale(0.8, 1.25, 1.0);
    gloveGeo.translate(0, -0.04 * H, 0.008 * H);
    attach(upperArmGeo, shoulderMat, this.shoulderL);
    attach(upperArmGeo, shoulderMat, this.shoulderR);
    attach(forearmGeo, coatMat, this.elbowL);
    attach(forearmGeo, coatMat, this.elbowR);
    attach(gloveGeo, trouserMat, wristL);
    attach(gloveGeo, trouserMat, wristR);

    // Arms rest slightly abducted so sleeves clear the coat barrel.
    const abduct = RAD(2) + RAD(2) * build;
    this.shoulderL.rotation.z = abduct; // +X side: positive z pushes the hand out
    this.shoulderR.rotation.z = -abduct;

    // ---- legs: trouser stubs under the hem, shins, boots ----
    const thighGeo = track(new THREE.CylinderGeometry(0.06 * H * w, 0.05 * H * w, (HIPS_Y - KNEE_Y) * H, 8));
    thighGeo.translate(0, (-(HIPS_Y - KNEE_Y) / 2) * H, 0);
    const shinGeo = track(new THREE.CylinderGeometry(0.05 * H * w, 0.042 * H * w, (KNEE_Y - ANKLE_Y) * H, 8));
    shinGeo.translate(0, (-(KNEE_Y - ANKLE_Y) / 2) * H, 0);
    const shaft = new THREE.CylinderGeometry(0.05 * H * w, 0.054 * H * w, 0.13 * H, 8);
    shaft.translate(0, -0.005 * H, 0);
    const toe = new THREE.BoxGeometry(0.078 * H * w, 0.05 * H, 0.105 * H);
    toe.translate(0, -0.045 * H, 0.055 * H);
    const bootGeo = track(mergeGeometries([shaft, toe], false));
    shaft.dispose();
    toe.dispose();
    attach(thighGeo, trouserMat, this.hipL);
    attach(thighGeo, trouserMat, this.hipR);
    attach(shinGeo, trouserMat, this.kneeL);
    attach(shinGeo, trouserMat, this.kneeR);
    attach(bootGeo, bootMat, this.ankleL);
    attach(bootGeo, bootMat, this.ankleR);

    // ---- optional backpack + bedroll (chest back) ----
    if (params.pack) {
      const body = new THREE.BoxGeometry(0.205 * H, 0.235 * H, 0.085 * H);
      body.translate(0, -0.02 * H, -0.15 * H);
      const roll = new THREE.CylinderGeometry(0.042 * H, 0.042 * H, 0.21 * H, 8);
      roll.rotateZ(Math.PI / 2);
      roll.translate(0, 0.115 * H, -0.15 * H);
      const packGeo = track(mergeGeometries([body, roll], false));
      body.dispose();
      roll.dispose();
      attach(packGeo, hoodMat, this.chest); // hood tone + heavy ash on the roll
    }
  }

  setLocomotion(speed: number, yaw: number): void {
    this.speed = speed;
    this.targetYaw = yaw;
    this.hasLocomotion = true;
  }

  update(dt: number, elapsed: number): void {
    // ---- group yaw: eased toward heading, with a subtle roll INTO the turn ----
    if (!this.yawInit) {
      // Respect spawn(): scenes write group.rotation.y directly before frame 1.
      this.curYaw = this.hasLocomotion ? this.targetYaw : this.group.rotation.y;
      if (!this.hasLocomotion) this.targetYaw = this.curYaw;
      this.yawInit = true;
    }
    const prevYaw = this.curYaw;
    this.curYaw = dampAngle(this.curYaw, this.targetYaw, TURN_RATE, dt);
    this.group.rotation.y = this.curYaw;
    const yawVel = dt > 0 ? (this.curYaw - prevYaw) / dt : 0;
    const rollTarget = clamp(-yawVel * 0.055, -ROLL_MAX, ROLL_MAX);
    this.roll += (rollTarget - this.roll) * Math.min(1, 8 * dt);
    this.group.rotation.z = this.roll;

    // ---- gait phase from distance travelled: feet plant without sliding ----
    const speed = this.speed;
    this.gaitPhase += (speed / this.strideLength) * TWO_PI * dt;
    while (this.gaitPhase >= TWO_PI) this.gaitPhase -= TWO_PI;
    const ph = this.gaitPhase;
    const s = smoothstep(0.05, 0.5, speed); // walkAmount
    const idle = 1 - s;
    const spd = clamp(speed / BRISK, 0, 1);
    const H = this.H;

    // ---- idle timers (weight shift 5–8 s, head drift 3.5–7 s) ----
    this.shiftTimer -= dt;
    if (this.shiftTimer <= 0) {
      this.shiftTimer = 5 + this.rng() * 3;
      this.shiftSide = -this.shiftSide;
      this.shiftTarget = this.shiftSide * (0.014 + this.rng() * 0.008);
    }
    this.shiftCur += (this.shiftTarget - this.shiftCur) * Math.min(1, 1.6 * dt);
    this.driftTimer -= dt;
    if (this.driftTimer <= 0) {
      this.driftTimer = 3.5 + this.rng() * 3.5;
      this.driftYaw = (this.rng() - 0.5) * 0.55;
      this.driftPitch = (this.rng() - 0.5) * 0.18;
    }
    const breath = Math.sin(elapsed * TWO_PI * 0.3 + this.breathSeed); // 0.3 Hz

    // ---- legs: thighs oppose, knees flex only in swing (straight at plant) ----
    const swing = Math.sin(ph); // > 0 = left thigh forward
    const ampThigh = RAD(20 + 6.5 * spd) * s; // ≈ ±26° at brisk
    const ampKnee = RAD(35 + 18 * spd) * s; // 35–55° swing flex
    // Mid-swing for the left leg is ph = 0 (cos = 1); stance clamps to 0.
    const kneeL = ampKnee * Math.pow(Math.max(0, Math.cos(ph)), 1.35) + RAD(4) * s;
    const kneeR = ampKnee * Math.pow(Math.max(0, -Math.cos(ph)), 1.35) + RAD(4) * s;
    const thighLrx = -swing * ampThigh; // negative rotation.x = swing forward
    const thighRrx = swing * ampThigh;
    this.hipL.rotation.x = thighLrx;
    this.hipR.rotation.x = thighRrx;
    this.kneeL.rotation.x = kneeL;
    this.kneeR.rotation.x = kneeR;
    // Ankles counter the leg chain: flat under load, toe-down through swing.
    const stanceL = Math.max(0, -Math.cos(ph));
    const stanceR = Math.max(0, Math.cos(ph));
    this.ankleL.rotation.x = -(thighLrx + kneeL) * (0.45 + 0.4 * stanceL);
    this.ankleR.rotation.x = -(thighRrx + kneeR) * (0.45 + 0.4 * stanceR);

    // ---- arms: opposite swing, elbows give a little when the arm is forward ----
    const ampArm = RAD(18) * s * (0.75 + 0.25 * spd);
    this.shoulderL.rotation.x = swing * ampArm; // opposite the left leg
    this.shoulderR.rotation.x = -swing * ampArm;
    this.elbowL.rotation.x = -RAD(10) - RAD(14) * s * Math.max(0, -swing);
    this.elbowR.rotation.x = -RAD(10) - RAD(14) * s * Math.max(0, swing);

    // ---- hips: lateral sway, pelvis yaw, vertical bob (2 dips / stride),
    //      idle weight shift ----
    this.hips.position.y = this.hipsBaseY - BOB_AMP * s * Math.abs(swing);
    this.hips.position.x = this.shiftCur * idle;
    this.hips.rotation.z = RAD(3) * s * Math.sin(ph - Math.PI / 2) + (this.shiftCur / 0.02) * RAD(1.2) * idle;
    this.hips.rotation.y = -RAD(3) * s * swing; // swing-side pelvis leads

    // ---- spine: forward lean (3° + 1.5°/(m/s)); coat breathes at idle ----
    const lean = RAD(3 + 1.5 * speed) * s;
    this.spine.rotation.x = lean;
    const b01 = 0.5 + 0.5 * breath;
    this.spine.scale.x = 1 + 0.012 * b01 * idle;
    this.spine.scale.z = 1 + 0.02 * b01 * idle;

    // ---- chest: counter-rotation against the pelvis; breathing rise ----
    this.chest.rotation.y = RAD(4) * s * swing;
    this.chest.rotation.x = RAD(1.1) * breath * idle;
    this.shoulderL.position.y = this.shoulderBaseY + 0.004 * H * b01 * idle;
    this.shoulderR.position.y = this.shoulderBaseY + 0.004 * H * b01 * idle;

    // ---- head: counter-bob ~50%, then look-at / idle drift (eased) ----
    this.head.position.y = this.headBaseY + BOB_AMP * 0.5 * s * Math.abs(swing);
    let wantYaw: number;
    let wantPitch: number;
    if (this.lookTarget !== null) {
      _look.copy(this.lookTarget);
      this.neck.worldToLocal(_look); // refreshes the matrix chain, alloc-free
      _look.y -= this.head.position.y; // aim from the head pivot, not the neck
      wantYaw = clamp(Math.atan2(_look.x, _look.z), -LOOK_YAW_MAX, LOOK_YAW_MAX);
      wantPitch = clamp(-Math.atan2(_look.y, Math.max(Math.hypot(_look.x, _look.z), 1e-4)), -LOOK_PITCH_MAX, LOOK_PITCH_MAX);
    } else {
      wantYaw = this.driftYaw * idle;
      wantPitch = this.driftPitch * idle - lean * 0.55; // gaze stays level on the move
    }
    this.headYaw = dampAngle(this.headYaw, wantYaw, HEAD_RATE, dt);
    this.headPitch = dampAngle(this.headPitch, wantPitch, HEAD_RATE, dt);
    this.head.rotation.y = this.headYaw;
    this.head.rotation.x = this.headPitch;
  }

  lookAt(target: THREE.Vector3 | null): void {
    // Reference is kept (not copied): a moving target tracks for free.
    this.lookTarget = target;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.geos.length = 0;
    this.mats.length = 0;
  }
}
