import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchWorldMaterial } from '../graphics/worldMaterial';
import { makeMetalPainted, makePaintedSign } from './textures';

/**
 * Street props (§5.3, §6.6), all procedural and aggressively instanced:
 * ash-buried bicycles in heaps, abandoned cars (3 paint variants),
 * lamp posts, rubble, hand-painted Danish signage, crowd barriers.
 * Each builder returns a Group the caller positions; instancing happens
 * INSIDE the group (InstancedMesh), so a heap of 60 bikes is ~2 draw calls.
 *
 * All materials patched with patchWorldMaterial(); up-facing-heavy props
 * (car roofs/bonnets via high ashAmount) read as buried.
 *
 * Ground-contact convention: every builder assumes the local ground plane
 * is y = 0 inside the returned Group; the caller positions the Group.
 */

// ---------------------------------------------------------------------------
// Deterministic RNG + shared scratch (no per-frame work; props are static,
// but scratch objects also keep the BUILD phase allocation-light).
// ---------------------------------------------------------------------------

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

const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _m4a = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** Open-ended cylinder connecting two points (frame tubes, stays, forks). */
function tubeBetween(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number,
): THREE.BufferGeometry {
  _dir.set(bx - ax, by - ay, bz - az);
  const len = _dir.length();
  const geo = new THREE.CylinderGeometry(r, r, len, 5, 1, true);
  geo.translate(0, len / 2, 0); // base at origin so the quaternion pivots there
  _quat.setFromUnitVectors(UP, _dir.normalize());
  geo.applyQuaternion(_quat);
  geo.translate(ax, ay, az);
  return geo;
}

/** Indexed single quad (p0→p1→p2→p3 counter-clockwise seen from the normal). */
function quadGeom(
  p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const positions = new Float32Array([
    p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/** Scale UVs in place (extrude UVs come out in metres; metal tile ≈ 2 m). */
function scaleUVs(g: THREE.BufferGeometry, s: number): void {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
  uv.needsUpdate = true;
}

function standardFromPaintedMetal(color: string, roughness: number, seed?: number): THREE.MeshStandardMaterial {
  const set = makeMetalPainted(color, seed);
  const mat = new THREE.MeshStandardMaterial({ map: set.map, roughness, metalness: 0.35 });
  if (set.roughnessMap) mat.roughnessMap = set.roughnessMap;
  if (set.normalMap) mat.normalMap = set.normalMap;
  return mat;
}

/**
 * Dispose every geometry/material under a prop group (extra helper export).
 * Textures from textures.ts are registry-owned there and NOT disposed here
 * (material.dispose() never frees its maps), so cached sets stay shared.
 */
export function disposeProps(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.geometry.dispose();
      const m = mesh.material;
      if (Array.isArray(m)) for (const mm of m) mm.dispose();
      else m.dispose();
      if ((obj as THREE.InstancedMesh).isInstancedMesh) (obj as THREE.InstancedMesh).dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Bike heap
// ---------------------------------------------------------------------------

/** One ~300-tri city bike, lying along local +X, ground at local y = 0. */
function makeBikeGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Wheels — rear axle (-0.50, 0.33), front axle (0.55, 0.33), ring in XY.
  const rear = new THREE.TorusGeometry(0.33, 0.018, 6, 16);
  rear.translate(-0.5, 0.33, 0);
  const front = new THREE.TorusGeometry(0.33, 0.018, 6, 16);
  front.translate(0.55, 0.33, 0);
  parts.push(rear, front);

  // Frame diamond. [ax, ay, az, bx, by, bz, r]
  const tubes: Array<[number, number, number, number, number, number, number]> = [
    [-0.05, 0.30, 0, 0.42, 0.74, 0, 0.022], // down tube
    [-0.22, 0.82, 0, 0.40, 0.78, 0, 0.020], // top tube
    [-0.05, 0.30, 0, -0.27, 0.90, 0, 0.020], // seat tube + post
    [-0.05, 0.30, 0.035, -0.50, 0.33, 0.035, 0.014], // chain stay L
    [-0.05, 0.30, -0.035, -0.50, 0.33, -0.035, 0.014], // chain stay R
    [-0.50, 0.33, 0.03, -0.24, 0.84, 0, 0.013], // seat stay (single, reads as pair)
    [0.40, 0.80, 0, 0.55, 0.33, 0, 0.018], // fork
    [0.40, 0.80, 0, 0.42, 0.88, 0, 0.020], // steerer/stem
  ];
  for (const [ax, ay, az, bx, by, bz, r] of tubes) parts.push(tubeBetween(ax, ay, az, bx, by, bz, r));

  // Handlebar: short bent cylinder (torus arc), flat, swept back toward rider.
  const bar = new THREE.TorusGeometry(0.22, 0.016, 4, 8, 2.0);
  bar.rotateZ(-1.0); // centre the arc bulge on +X
  bar.rotateX(Math.PI / 2); // lay it flat, spanning Z
  bar.rotateY(Math.PI); // bulge toward -X (swept back)
  bar.translate(0.42, 0.90, 0);
  parts.push(bar);

  // Saddle.
  const saddle = new THREE.BoxGeometry(0.26, 0.05, 0.12);
  saddle.translate(-0.27, 0.93, 0);
  parts.push(saddle);

  const merged = mergeGeometries(parts, false);
  // Centre on the geometric middle so heap rolls pivot around the bike body.
  merged.computeBoundingBox();
  const c = merged.boundingBox!.getCenter(_pos);
  merged.translate(-c.x, -c.y, -c.z);
  return merged;
}

/** Heap of fallen bicycles scattered in a rough ellipse (rx × rz metres). */
export function buildBikeHeap(count: number, rx: number, rz: number, seed?: number): THREE.Group {
  const rng = mulberry32(seed ?? 1337);
  const group = new THREE.Group();
  group.name = 'bikeHeap';

  const geometry = makeBikeGeometry();
  // Muted near-black metal; ash blankets the jumble heavily.
  const material = new THREE.MeshStandardMaterial({
    color: '#17191b',
    roughness: 0.6,
    metalness: 0.55,
  });
  patchWorldMaterial(material, { ashAmount: 0.9 });

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Pile envelope: height rises toward the ellipse centre.
  const pileHeight = 0.55 + Math.min(count, 80) * 0.008;
  for (let i = 0; i < count; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()); // uniform over the ellipse
    const px = Math.cos(ang) * rx * rad;
    const pz = Math.sin(ang) * rz * rad;
    const envelope = 1 - rad * rad;
    const py = 0.24 + envelope * rng() * pileHeight;

    const yaw = rng() * Math.PI * 2;
    const side = rng() < 0.5 ? -1 : 1;
    // Mostly fallen flat (roll near ±90°), a few only leaning.
    const roll =
      rng() < 0.8
        ? side * (Math.PI / 2 + (rng() - 0.5) * 0.7)
        : side * (0.35 + rng() * 0.5);
    const pitch = (rng() - 0.5) * 0.3;

    _euler.set(roll, yaw, pitch, 'YXZ'); // yaw first, then roll about bike axis
    _quat.setFromEuler(_euler);
    const s = 0.95 + rng() * 0.1;
    _m4a.compose(_pos.set(px, py, pz), _quat, _scl.set(s, s, s));
    mesh.setMatrixAt(i, _m4a);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();

  group.add(mesh);
  return group;
}

// ---------------------------------------------------------------------------
// Abandoned cars
// ---------------------------------------------------------------------------

/**
 * Abandoned cars along a street. Each entry: position + yaw (radians) +
 * variant 0..2 (muted paint colours). Doors stay shut; some bonnets ajar.
 */
export interface CarPlacement {
  x: number;
  z: number;
  yaw: number;
  variant: 0 | 1 | 2;
}

const CAR_PAINT = ['#6a6e71', '#5d5a52', '#4e545c'] as const;

// Hatchback side profile (x = length, y = height); counter-clockwise.
const CAR_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [2.1, 0.28], // front lower
  [2.1, 0.58], // nose
  [1.92, 0.7], // bonnet leading edge
  [1.18, 0.84], // windscreen base
  [0.4, 1.38], // roof front
  [-1.28, 1.42], // roof rear
  [-1.98, 0.84], // hatch base
  [-2.1, 0.78], // tailgate top
  [-2.1, 0.28], // rear lower
];

const CAR_BODY_DEPTH = 1.58; // + 2 × bevelThickness ≈ 1.68 m overall width
const WHEEL_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [1.32, 0.31, 0.72],
  [1.32, 0.31, -0.72],
  [-1.32, 0.31, 0.72],
  [-1.32, 0.31, -0.72],
];

/**
 * Body = ExtrudeGeometry of the side profile swept across the width.
 * Chosen over merged boxes because the whole hatchback silhouette (nose,
 * bonnet, windscreen rake, roof, steep hatch) is ONE closed outline — a box
 * stack would need 6+ pieces, hand-mitred seams, and would still read brick-y;
 * the extrude with a 1-segment bevel gives softly rounded sills/roof edges
 * for free. Bumpers + mirrors stay as tiny boxes merged in.
 */
function makeCarBodyGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(CAR_PROFILE[0][0], CAR_PROFILE[0][1]);
  for (let i = 1; i < CAR_PROFILE.length; i++) shape.lineTo(CAR_PROFILE[i][0], CAR_PROFILE[i][1]);
  shape.closePath();

  const body = new THREE.ExtrudeGeometry(shape, {
    depth: CAR_BODY_DEPTH,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.03,
    bevelSegments: 1,
    curveSegments: 1,
  });
  body.translate(0, 0, -CAR_BODY_DEPTH / 2);
  scaleUVs(body, 0.5); // extrude UVs are in metres; paint tile ≈ 2 m

  const parts: THREE.BufferGeometry[] = [body];
  // Bumpers (slightly proud of the beveled nose/tail at ±2.13).
  for (const sx of [1, -1]) {
    const bumper = new THREE.BoxGeometry(0.2, 0.16, 1.72).toNonIndexed();
    bumper.translate(sx * 2.12, 0.4, 0);
    parts.push(bumper);
  }
  // Side mirrors.
  for (const sz of [1, -1]) {
    const mirror = new THREE.BoxGeometry(0.05, 0.1, 0.16).toNonIndexed();
    mirror.translate(0.55, 1.0, sz * 0.9);
    parts.push(mirror);
  }
  return mergeGeometries(parts, false);
}

/** Dark wheel-arch shadow boxes — cheap stand-in for real arch cutouts. */
function makeCarArchGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const [wx, , wz] of WHEEL_OFFSETS) {
    const arch = new THREE.BoxGeometry(0.78, 0.5, 0.26);
    arch.translate(wx, 0.3, Math.sign(wz) * 0.73); // outer face 0.02 proud of body
    parts.push(arch);
  }
  return mergeGeometries(parts, false);
}

/** Windscreen / rear hatch glass / two side bands as merged offset quads. */
function makeCarGlassGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const lift = 0.015; // proud of the body surface so glass is visible

  // Windscreen on the rake (1.18,0.84) → (0.40,1.38); outward n=(0.559,0.829).
  {
    const n = new THREE.Vector2(0.559, 0.829).normalize();
    const P = (u: number, z: number) =>
      new THREE.Vector3(
        1.18 + (0.4 - 1.18) * u + n.x * lift,
        0.84 + (1.38 - 0.84) * u + n.y * lift,
        z,
      );
    parts.push(quadGeom(P(0.08, 0.7), P(0.08, -0.7), P(0.94, -0.7), P(0.94, 0.7)));
  }
  // Rear glass on the hatch (-1.98,0.84) → (-1.28,1.42); outward n=(-0.651,0.759).
  {
    const n = new THREE.Vector2(-0.651, 0.759).normalize();
    const Q = (u: number, z: number) =>
      new THREE.Vector3(
        -1.98 + (-1.28 - -1.98) * u + n.x * lift,
        0.84 + (1.42 - 0.84) * u + n.y * lift,
        z,
      );
    parts.push(quadGeom(Q(0.3, -0.66), Q(0.3, 0.66), Q(0.95, 0.66), Q(0.95, -0.66)));
  }
  // Side window bands (greenhouse), 0.02 proud of the ±0.84 body side.
  const zs = 0.86;
  parts.push(
    quadGeom(
      new THREE.Vector3(-1.2, 0.94, zs),
      new THREE.Vector3(0.3, 0.94, zs),
      new THREE.Vector3(0.3, 1.3, zs),
      new THREE.Vector3(-1.2, 1.3, zs),
    ),
    quadGeom(
      new THREE.Vector3(0.3, 0.94, -zs),
      new THREE.Vector3(-1.2, 0.94, -zs),
      new THREE.Vector3(-1.2, 1.3, -zs),
      new THREE.Vector3(0.3, 1.3, -zs),
    ),
  );
  return mergeGeometries(parts, false);
}

export function buildAbandonedCars(placements: CarPlacement[], seed?: number): THREE.Group {
  const rng = mulberry32(seed ?? 2026);
  const group = new THREE.Group();
  group.name = 'abandonedCars';
  const n = placements.length;
  if (n === 0) return group;

  // Per-car matrices, deterministic order (one rng draw per placement).
  const carMatrices: THREE.Matrix4[] = [];
  for (const p of placements) {
    const roll = (rng() * 2 - 1) * THREE.MathUtils.degToRad(1.5); // flat-tyre lean
    _euler.set(roll, p.yaw, 0, 'YXZ');
    _quat.setFromEuler(_euler);
    // y = 0: wheel centres sit at local y 0.31 (= radius), tyres touch ground.
    carMatrices.push(new THREE.Matrix4().compose(_pos.set(p.x, 0, p.z), _quat, _scl.set(1, 1, 1)));
  }

  // Bodies — one InstancedMesh per paint variant actually used.
  const bodyGeometry = makeCarBodyGeometry();
  const byVariant: number[][] = [[], [], []];
  placements.forEach((p, i) => byVariant[p.variant].push(i));
  for (let v = 0; v < 3; v++) {
    const indices = byVariant[v];
    if (indices.length === 0) continue;
    const paint = standardFromPaintedMetal(CAR_PAINT[v], 0.5, (seed ?? 2026) + v);
    patchWorldMaterial(paint, { ashAmount: 1.25 }); // buried bonnets/roofs = hero read
    const bodies = new THREE.InstancedMesh(bodyGeometry, paint, indices.length);
    bodies.castShadow = true;
    bodies.receiveShadow = true;
    indices.forEach((carIdx, k) => bodies.setMatrixAt(k, carMatrices[carIdx]));
    bodies.instanceMatrix.needsUpdate = true;
    bodies.computeBoundingSphere();
    bodies.name = `carBodies${v}`;
    group.add(bodies);
  }

  // Wheels — ONE InstancedMesh for all 4×N, axis along Z.
  const wheelGeometry = new THREE.CylinderGeometry(0.31, 0.31, 0.2, 12);
  wheelGeometry.rotateX(Math.PI / 2);
  const rubber = new THREE.MeshStandardMaterial({ color: '#141516', roughness: 0.95, metalness: 0 });
  patchWorldMaterial(rubber, { ashAmount: 0.4 });
  const wheels = new THREE.InstancedMesh(wheelGeometry, rubber, 4 * n);
  wheels.castShadow = true;
  wheels.receiveShadow = true;
  for (let i = 0; i < n; i++) {
    for (let w = 0; w < 4; w++) {
      const off = WHEEL_OFFSETS[w];
      _m4b.makeTranslation(off[0], off[1], off[2]);
      _m4a.multiplyMatrices(carMatrices[i], _m4b);
      wheels.setMatrixAt(i * 4 + w, _m4a);
    }
  }
  wheels.instanceMatrix.needsUpdate = true;
  wheels.computeBoundingSphere();
  wheels.name = 'carWheels';
  group.add(wheels);

  // Glass — ONE InstancedMesh; windscreens collect SOME ash.
  const glassGeometry = makeCarGlassGeometry();
  const glassMat = new THREE.MeshStandardMaterial({
    color: '#101316',
    roughness: 0.15,
    metalness: 0.2,
  });
  patchWorldMaterial(glassMat, { ashAmount: 0.25 });
  const glass = new THREE.InstancedMesh(glassGeometry, glassMat, n);
  glass.receiveShadow = true;
  for (let i = 0; i < n; i++) glass.setMatrixAt(i, carMatrices[i]);
  glass.instanceMatrix.needsUpdate = true;
  glass.computeBoundingSphere();
  glass.name = 'carGlass';
  group.add(glass);

  // Wheel-arch shadow boxes — ONE matte near-black InstancedMesh.
  const archGeometry = makeCarArchGeometry();
  const archMat = new THREE.MeshStandardMaterial({ color: '#0c0d0e', roughness: 0.9, metalness: 0 });
  patchWorldMaterial(archMat, { ashAmount: 0.15 });
  const arches = new THREE.InstancedMesh(archGeometry, archMat, n);
  arches.receiveShadow = true;
  for (let i = 0; i < n; i++) arches.setMatrixAt(i, carMatrices[i]);
  arches.instanceMatrix.needsUpdate = true;
  arches.computeBoundingSphere();
  arches.name = 'carArches';
  group.add(arches);

  return group;
}

// ---------------------------------------------------------------------------
// Lamp posts
// ---------------------------------------------------------------------------

/** Pole + curved arm + head, merged. Arm reaches toward local +X. */
function makeLampPostGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const pole = new THREE.CylinderGeometry(0.06, 0.06, 5.2, 10);
  pole.translate(0, 2.6, 0);
  parts.push(pole);

  // Arm: torus arc spanning θ ∈ [80°, 180°] about centre (0.9, 5.2) — the
  // θ=180° end meets the pole top tangent-vertical, the θ=80° end hangs
  // over the road at ≈(1.06, 6.09) turning gently downward.
  const arc = THREE.MathUtils.degToRad(100);
  const arm = new THREE.TorusGeometry(0.9, 0.045, 6, 12, arc);
  arm.rotateZ(Math.PI - arc);
  arm.translate(0.9, 5.2, 0);
  parts.push(arm);

  const headX = 0.9 + 0.9 * Math.cos(THREE.MathUtils.degToRad(80));
  const headTopY = 5.2 + 0.9 * Math.sin(THREE.MathUtils.degToRad(80));

  const stem = new THREE.CylinderGeometry(0.03, 0.03, 0.12, 6);
  stem.translate(headX, headTopY - 0.07, 0);
  parts.push(stem);

  const shade = new THREE.ConeGeometry(0.22, 0.16, 10, 1, true); // apex up, open rim down
  shade.translate(headX, headTopY - 0.18, 0);
  parts.push(shade);

  const lamp = new THREE.CylinderGeometry(0.075, 0.075, 0.14, 8);
  lamp.translate(headX, headTopY - 0.24, 0);
  parts.push(lamp);

  return mergeGeometries(parts, false);
}

/** Copenhagen-style lamp posts (unlit, ash-capped) at given x/z positions. */
export function buildLampPosts(positions: Array<{ x: number; z: number }>): THREE.Group {
  const group = new THREE.Group();
  group.name = 'lampPosts';
  if (positions.length === 0) return group;

  const geometry = makeLampPostGeometry();
  const material = standardFromPaintedMetal('#23282a', 0.55);
  patchWorldMaterial(material, { ashAmount: 0.7 }); // ash caps on shade tops

  const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  positions.forEach((p, i) => {
    // Street runs along Z centred on x = 0: arm (local +X) hangs over the road.
    const yaw = p.x > 0 ? Math.PI : 0;
    _euler.set(0, yaw, 0, 'YXZ');
    _quat.setFromEuler(_euler);
    _m4a.compose(_pos.set(p.x, 0, p.z), _quat, _scl.set(1, 1, 1));
    mesh.setMatrixAt(i, _m4a);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();

  group.add(mesh);
  return group;
}

// ---------------------------------------------------------------------------
// Rubble piles
// ---------------------------------------------------------------------------

/**
 * Icosahedron with vertices displaced ±35%. PolyhedronGeometry is a
 * non-indexed soup, so displacement is keyed on quantised positions: shared
 * corners move together and the chunk stays watertight + flat-shaded.
 */
function deformedIco(rng: () => number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const factors = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let f = factors.get(key);
    if (f === undefined) {
      f = 1 + (rng() - 0.5) * 0.7;
      factors.set(key, f);
    }
    pos.setXYZ(i, x * f, y * f, z * f);
  }
  g.computeVertexNormals();
  return g;
}

/** Clump of 3 pre-deformed variants merged — one instance reads as a clump. */
function makeRubbleChunkGeometry(rng: () => number): THREE.BufferGeometry {
  const placements: Array<{ p: [number, number, number]; r: [number, number, number]; s: number }> = [
    { p: [0, 0, 0], r: [0, 0, 0], s: 1.0 },
    { p: [0.62, -0.18, 0.4], r: [0.7, 1.9, 0.3], s: 0.72 },
    { p: [-0.55, -0.22, -0.42], r: [1.2, 0.4, 2.1], s: 0.5 },
  ];
  const parts = placements.map(({ p, r, s }) => {
    const g = deformedIco(rng);
    _euler.set(r[0], r[1], r[2], 'XYZ');
    _quat.setFromEuler(_euler);
    _m4a.compose(_pos.set(p[0], p[1], p[2]), _quat, _scl.set(s, s, s));
    g.applyMatrix4(_m4a);
    return g;
  });
  return mergeGeometries(parts, false);
}

const CHUNKS_PER_PILE = 14;

/** Rubble/debris piles (instanced deformed chunks) at given positions. */
export function buildRubblePiles(
  piles: Array<{ x: number; z: number; radius: number; height: number }>,
  seed?: number,
): THREE.Group {
  const rng = mulberry32(seed ?? 4041);
  const group = new THREE.Group();
  group.name = 'rubblePiles';
  if (piles.length === 0) return group;

  const geometry = makeRubbleChunkGeometry(rng);
  const material = new THREE.MeshStandardMaterial({
    color: '#66686a',
    roughness: 0.95,
    metalness: 0,
  });
  patchWorldMaterial(material, { ashAmount: 1.5 });

  const mesh = new THREE.InstancedMesh(geometry, material, piles.length * CHUNKS_PER_PILE);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  let idx = 0;
  for (const pile of piles) {
    for (let k = 0; k < CHUNKS_PER_PILE; k++) {
      const ang = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * pile.radius * 0.8;
      const s = 0.15 + rng() * 0.45;
      // Height envelope: chunks may stack toward the centre; outer ones sink.
      const envelope = Math.max(0, 1 - (r / Math.max(pile.radius, 1e-3)) ** 2);
      const py = envelope * pile.height * rng() - s * 0.35; // partial burial
      _euler.set(rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2, 'XYZ');
      _quat.setFromEuler(_euler);
      _m4a.compose(
        _pos.set(pile.x + Math.cos(ang) * r, py, pile.z + Math.sin(ang) * r),
        _quat,
        _scl.set(s, s * 0.6, s), // flattened: rubble settles low
      );
      mesh.setMatrixAt(idx++, _m4a);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();

  group.add(mesh);
  return group;
}

// ---------------------------------------------------------------------------
// Painted sign
// ---------------------------------------------------------------------------

/**
 * Plywood sign on two posts with hand-painted Danish text
 * (e.g. ["DER ER IKKE MERE", "GÅ MOD ROSKILDE"]).
 */
export function buildPaintedSign(lines: string[], width = 2.2): THREE.Group {
  const group = new THREE.Group();
  group.name = 'paintedSign';

  const boardH = 0.9;
  const boardT = 0.018;
  const tilt = THREE.MathUtils.degToRad(4);
  // Board sits flush against the 5 cm posts' front face (z = 0.025).
  const boardM = new THREE.Matrix4().compose(
    _pos.set(0, 1.02, 0.025 + boardT / 2),
    _quat.setFromEuler(_euler.set(0, 0, tilt, 'XYZ')),
    _scl.set(1, 1, 1),
  );

  // Timber: two leaning posts + the board box, merged → 1 draw call.
  const timberParts: THREE.BufferGeometry[] = [];
  const postX = width / 2 - 0.18;
  for (const side of [-1, 1]) {
    const post = new THREE.BoxGeometry(0.05, 1.6, 0.05);
    post.translate(0, 0.8, 0); // pivot at base
    post.rotateZ(side * THREE.MathUtils.degToRad(2.5)); // opposing leans
    post.translate(side * postX, 0, 0);
    timberParts.push(post);
  }
  const boardBox = new THREE.BoxGeometry(width, boardH, boardT);
  boardBox.applyMatrix4(boardM);
  timberParts.push(boardBox);

  const timberMat = new THREE.MeshStandardMaterial({
    color: '#6f675b',
    roughness: 0.92,
    metalness: 0,
  });
  patchWorldMaterial(timberMat, { ashAmount: 0.8 }); // post tops + board edge cap
  const timber = new THREE.Mesh(mergeGeometries(timberParts, false), timberMat);
  timber.castShadow = true;
  timber.receiveShadow = true;
  group.add(timber);

  // Painted FRONT face only: a plane floated 1.5 mm off the board box —
  // cleaner than per-face UV surgery on BoxGeometry.
  const front = new THREE.PlaneGeometry(width - 0.04, boardH - 0.04);
  front.translate(0, 0, boardT / 2 + 0.0015);
  front.applyMatrix4(boardM);
  const signMat = new THREE.MeshStandardMaterial({
    map: makePaintedSign(lines),
    roughness: 0.85,
    metalness: 0,
  });
  patchWorldMaterial(signMat, { ashAmount: 0.1 }); // near-vertical, stays legible
  const face = new THREE.Mesh(front, signMat);
  face.castShadow = false; // coplanar with the board box, which already casts
  face.receiveShadow = true;
  group.add(face);

  return group;
}
