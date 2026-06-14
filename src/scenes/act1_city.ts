import * as THREE from 'three';
import type { Engine } from '../core/engine';
import type { GameScene } from '../core/sceneManager';
import type { Input } from '../core/input';
import type { PostStack } from '../graphics/post';
import { PlayerController } from '../actors/player';
import { HumanoidActor } from '../actors/humanoid';
import { DogActor } from '../actors/dog';
import { Follower } from '../actors/follower';
import { ColliderWorld } from '../world/collision';
import { SkySystem } from '../graphics/sky';
import { SunRig } from '../graphics/lights';
import { AshParticles } from '../graphics/ashParticles';
import { ACT_CONFIGS, getSunDirection } from '../graphics/palette';
import { worldUniforms } from '../graphics/worldMaterial';
import { qualityManager } from '../core/quality';
import { TriggerSet } from '../core/triggers';
import type { MeterEnv } from '../systems/meters';
import { RadiationField, type RadiationSource } from '../systems/geiger';
import type { RadioSignal } from '../systems/radio';
import type { GameSystems } from '../systems/gameSystems';
import { PickupSet } from '../systems/pickups';
import { Act1Beats } from '../story/act1Beats';
import {
  buildFacadeBlock,
  buildSkylineCards,
  buildStreetGround,
  updateCityFlicker,
  type FacadeParams,
} from '../world/cityKit';
import {
  buildAbandonedCars,
  buildBikeHeap,
  buildLampPosts,
  buildPaintedSign,
  buildRubblePiles,
  type CarPlacement,
} from '../world/props';
import { makePlasterFacade, makeAshDrift, disposeAllGeneratedTextures, applyPBR } from '../world/textures';
import { buildCandleFlat } from '../world/interiorKit';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchWorldMaterial } from '../graphics/worldMaterial';

/**
 * Act I — BYEN, M2 scope: the playable street. Street composition mirrors
 * scenes/lookdev.ts (same placements; provenance commented) and adds:
 * collision everywhere, Ellen/Jonas/Birk, a courtyard passage
 * (gennemgangen) through the left block row, an enterable candle flat
 * behind the right shopfront with an exposure-adaptation threshold, and a
 * backdrop cross street at the north end. The player area is capped at
 * z ∈ [−150, +40]; the T-junction is scenery until M4 builds the full
 * Act-I traversal network.
 */

const BUILDING_LINE = 10;
const FACADE_BODY_DEPTH = 12;
const ALLEY_GAP = 2.5;
const GOD_RAYS_DISTANCE = 820;

// Flat placement (right block 1): door wall flush just inside the building
// line, door centred on a shopfront bay. Local +Z (door wall) faces world −X:
// rotation θ = −π/2 maps local (x,z) → world (−z, +x), so
// world = (CENTER.x − lz, CENTER.z + lx).
const FLAT_ROT = -Math.PI / 2;
const FLAT_CENTER_X = 12.56; // door wall (local z=+2.5) lands at x = 10.06
const FLAT_CENTER_Z = 22.5;
const FLAT_FLOOR_Y = 0.13;
// Interior bounds for the exposure trigger (slight hysteresis between them).
const FLAT_ENTER = { x0: 10.25, x1: 14.9, z0: 19.8, z1: 25.2 };
const FLAT_EXIT = { x0: 10.0, x1: 15.1, z0: 19.55, z1: 25.45 };
const EXPOSURE_INTERIOR = 1.35;

// Courtyard behind the left row, reached through the alley gap between
// left blocks 1 and 2 (z 5.5..8, x −22..−10).
const PASSAGE = { z0: 5.5, z1: 8, x0: -22, x1: -10 };
const COURT = { x0: -34, x1: -22, z0: -1, z1: 15 };

interface FacadeRowResult {
  blocks: THREE.Group[];
}

export interface Act1CityScene extends GameScene {
  player: PlayerController;
  /** Sun disc for god rays; main.ts hands it to post.setGodRaysSource. */
  godRaysSource: THREE.Mesh;
}

// Radiation hot zones — the rubble piles (§4; matches the map + beat 3b).
// Radii reach into the street centre so the field registers on the walked
// route (player tracks x≈1–3); intensity peaks at the rubble on the kerb.
const RAD_SOURCES: RadiationSource[] = [
  { x: 9.1, z: -18, radius: 11, intensity: 0.85 },
  { x: -9.2, z: -55, radius: 11, intensity: 0.8 },
  { x: -9.0, z: -120, radius: 12, intensity: 0.92 },
];

// Authored radio signals for Act I. Both transmit from the southwest
// (toward Roskilde): strength rises as Ellen walks down-street (−z) and
// west. ROSKILDE morse on 96.4; a faint voice band higher up the dial.
function buildAct1Signals(player: PlayerController): RadioSignal[] {
  // Strength keyed to progress down the street toward the SW fog edge.
  const strengthSW = (): number => {
    const z = player.position.z;
    // 0 at the flat (z≈22), rising to ~1 deep south (z≈−150).
    return Math.min(1, Math.max(0, (22 - z) / 150));
  };
  return [
    {
      freq: 96.4,
      bandwidth: 0.5,
      kind: 'morse',
      message: 'ROSKILDE',
      strengthAt: () => 0.25 + 0.75 * strengthSW(),
    },
    {
      freq: 101.7,
      bandwidth: 0.45,
      kind: 'voice',
      strengthAt: () => 0.15 + 0.4 * strengthSW(),
    },
  ];
}

const _box = new THREE.Box3();

export function createAct1City(
  engine: Engine,
  input: Input,
  post: PostStack,
  deps: GameSystems,
): Act1CityScene {
  const act1 = ACT_CONFIGS.act1;
  const { state, meters, geiger, radio, dialogue, hud, radioOverlay, journal, save, sfx } = deps;
  const group = new THREE.Group();
  group.name = 'act1-city';
  const colliders = new ColliderWorld();
  const blocks: THREE.Group[] = [];
  const extraMats: THREE.Material[] = [];
  const extraGeos: THREE.BufferGeometry[] = [];

  // ---------------------------------------------------------------------
  // Façade rows (placements mirror lookdev.ts), with collision: one box per
  // block (x ±[10,22]), alley gaps closed by thin building-line boxes —
  // except the passage gap on the left and the flat door gap on the right.
  // ---------------------------------------------------------------------
  function placeFacadeRow(
    side: -1 | 1,
    specs: FacadeParams[],
    zStart: number,
    opts: { passageGapAfter?: number; doorGap?: { z0: number; z1: number } } = {},
  ): FacadeRowResult {
    const rotY = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    const centerX = side * (BUILDING_LINE + FACADE_BODY_DEPTH / 2);
    let zCursor = zStart;
    specs.forEach((params, i) => {
      const block = buildFacadeBlock(params);
      _box.setFromObject(block);
      const width = _box.max.x - _box.min.x;
      block.rotation.y = rotY;
      block.position.set(centerX, 0, zCursor - width / 2);
      group.add(block);
      blocks.push(block);

      const zTop = zCursor;
      const zBot = zCursor - width;
      const door = opts.doorGap;
      if (door && door.z1 < zTop && door.z0 > zBot && side > 0) {
        // Split the block collider around the flat's doorway; box C blocks
        // the strip behind the room so its back wall is never bypassed.
        colliders.addBox(centerX, (zTop + door.z1) / 2, 6, (zTop - door.z1) / 2);
        colliders.addBox(centerX, (door.z0 + zBot) / 2, 6, (door.z0 - zBot) / 2);
        colliders.addBox(18.6, (door.z0 + door.z1) / 2, 3.4, (door.z1 - door.z0) / 2);
      } else {
        colliders.addBox(centerX, zCursor - width / 2, 6, width / 2);
      }

      // Close the alley gap to the NEXT block (thin wall at the building
      // line) unless it is the courtyard passage.
      if (i < specs.length - 1 && opts.passageGapAfter !== i) {
        colliders.addBox(side * BUILDING_LINE, zBot - ALLEY_GAP / 2, 0.12, ALLEY_GAP / 2 + 0.3);
      }
      zCursor = zBot - ALLEY_GAP;
    });
    return { blocks };
  }

  // Same block specs as lookdev (lit windows mid-distance).
  placeFacadeRow(
    -1,
    [
      { bays: 8, floors: 5, style: 'plaster', tint: '#8a8068', seed: 11, shopfront: true },
      { bays: 10, floors: 5, style: 'brick', tint: '#6e5d52', seed: 12, litWindows: 2 },
      { bays: 7, floors: 5, style: 'plaster', tint: '#767a70', seed: 13, litWindows: 2 },
    ],
    32,
    { passageGapAfter: 0 }, // gap between blocks 1↔2 is the gennemgang
  );
  placeFacadeRow(
    1,
    [
      { bays: 9, floors: 5, style: 'plaster', tint: '#87726a', seed: 21, shopfront: true },
      { bays: 7, floors: 5, style: 'plaster', tint: '#767a70', seed: 22, litWindows: 2 },
      { bays: 10, floors: 5, style: 'brick', tint: '#6e5d52', seed: 23, litWindows: 1 },
    ],
    36,
    { doorGap: { z0: 21.9, z1: 23.1 } },
  );
  placeFacadeRow(-1, [{ bays: 9, floors: 5, style: 'plaster', tint: '#8a8068', seed: 31 }], -112);
  placeFacadeRow(1, [{ bays: 8, floors: 5, style: 'plaster', tint: '#87726a', seed: 32 }], -115);

  // ---- Street ground (z ∈ [−110, +110]) ----
  group.add(buildStreetGround(220, 11, 4.5));

  // ---- Cross street backdrop at the north end (visual only) ----
  const crossGround = buildStreetGround(120, 9, 3.5);
  crossGround.rotation.y = Math.PI / 2;
  crossGround.position.set(0, 0.01, 50);
  group.add(crossGround);
  const northSpecs: FacadeParams[] = [
    { bays: 9, floors: 5, style: 'plaster', tint: '#767a70', seed: 41 },
    { bays: 10, floors: 5, style: 'plaster', tint: '#8a8068', seed: 43 },
  ];
  let nx = -34;
  const backdrop = new THREE.Group();
  backdrop.add(crossGround);
  for (const spec of northSpecs) {
    const block = buildFacadeBlock(spec);
    _box.setFromObject(block);
    const width = _box.max.x - _box.min.x;
    block.rotation.y = Math.PI; // front faces −Z, toward the cross street
    block.position.set(nx + width / 2, 0, 63 + FACADE_BODY_DEPTH / 2 - 6);
    backdrop.add(block);
    blocks.push(block);
    nx += width + ALLEY_GAP;
  }
  // Backdrop is unreachable scenery beyond the player cap: shadow casting
  // there only burns the shadow-pass draw budget.
  backdrop.traverse((obj) => {
    (obj as THREE.Mesh).castShadow = false;
  });
  group.add(backdrop);

  // ---- Cars (lookdev placements + two on the cross street) ----
  const carPlacements: CarPlacement[] = [
    { x: 2.55, z: 18.0, yaw: Math.PI + 0.04, variant: 0 },
    { x: 2.7, z: 4.1, yaw: Math.PI - 0.05, variant: 1 },
    { x: 2.5, z: -9.1, yaw: Math.PI + 0.02, variant: 2 },
    { x: 2.9, z: -23.1, yaw: Math.PI + 0.5, variant: 0 },
    { x: 2.6, z: -35.7, yaw: Math.PI - 0.03, variant: 1 },
    { x: 2.45, z: -49.1, yaw: Math.PI + 0.06, variant: 2 },
    { x: 3.0, z: -63.1, yaw: Math.PI - 0.5, variant: 0 },
    { x: 2.6, z: -76.6, yaw: Math.PI - 0.02, variant: 1 },
    { x: 2.5, z: -90.6, yaw: Math.PI + 0.05, variant: 2 },
    { x: -2.6, z: -42.0, yaw: 0.08, variant: 0 },
    { x: -18, z: 51.8, yaw: Math.PI / 2 - 0.04, variant: 1 },
    { x: 26, z: 48.3, yaw: -Math.PI / 2 + 0.07, variant: 2 },
  ];
  group.add(buildAbandonedCars(carPlacements, 4));
  for (const p of carPlacements) {
    if (p.z < 42) colliders.addBox(p.x, p.z, 2.15, 0.9, p.yaw);
  }

  // ---- Bike heaps ----
  const bigHeap = buildBikeHeap(38, 3, 1.8, 7);
  bigHeap.position.set(-8, 0, 10);
  group.add(bigHeap);
  colliders.addBox(-8, 10, 2.8, 1.7);
  const smallHeap = buildBikeHeap(12, 1.8, 1.2, 19);
  smallHeap.position.set(8.2, 0, -30);
  group.add(smallHeap);
  colliders.addBox(8.2, -30, 1.7, 1.1);

  // ---- Lamp posts (lookdev layout) ----
  const lampZsLeft = [40, 16, -8, -32, -56, -80, -104, -128];
  const lampZsRight = [28, 4, -20, -44, -68, -92, -116, -140];
  const leftPosts = buildLampPosts(lampZsLeft.map((z) => ({ x: -9.6, z })));
  group.add(leftPosts);
  const rightPosts = buildLampPosts(lampZsRight.map((z) => ({ x: -9.6, z: -z })));
  rightPosts.rotation.y = Math.PI;
  group.add(rightPosts);
  // Right-side posts: built at (−9.6, −z) then rotated π → world (9.6, +z).
  for (const z of lampZsLeft) colliders.addBox(-9.6, z, 0.12, 0.12);
  for (const z of lampZsRight) colliders.addBox(9.6, z, 0.12, 0.12);

  // ---- Sign + rubble (lookdev placements) ----
  const sign = buildPaintedSign(['DER ER IKKE MERE', 'GÅ MOD ROSKILDE']);
  sign.position.set(8, 0, 2);
  sign.rotation.y = -0.4;
  group.add(sign);
  colliders.addBox(8, 2, 1.15, 0.18, -0.4);
  const rubblePiles = [
    { x: -9.2, z: -55, radius: 1.5, height: 0.5 },
    { x: 9.1, z: -18, radius: 1.1, height: 0.4 },
    { x: -9.0, z: -120, radius: 1.8, height: 0.6 },
  ];
  group.add(buildRubblePiles(rubblePiles, 5));
  for (const p of rubblePiles) colliders.addBox(p.x, p.z, p.radius * 0.8, p.radius * 0.8);

  // ---- Skyline ----
  group.add(buildSkylineCards(380));

  // ---------------------------------------------------------------------
  // Gennemgangen + courtyard
  // ---------------------------------------------------------------------
  const plasterMat = new THREE.MeshStandardMaterial({ roughness: 0.95 });
  applyPBR(plasterMat, makePlasterFacade('#8a8068', 61));
  // (walls collect a little ash on top edges via worldMaterial)
  patchAsh(plasterMat, 0.4);
  extraMats.push(plasterMat);

  // Arch band over the passage (walk under: collider yMin 2.3).
  const archGeo = new THREE.BoxGeometry(12, 3.7, PASSAGE.z1 - PASSAGE.z0);
  extraGeos.push(archGeo);
  const arch = new THREE.Mesh(archGeo, plasterMat);
  arch.position.set(-16, 2.3 + 3.7 / 2, (PASSAGE.z0 + PASSAGE.z1) / 2);
  arch.castShadow = true;
  arch.receiveShadow = true;
  group.add(arch);
  colliders.addBox(-16, (PASSAGE.z0 + PASSAGE.z1) / 2, 6, (PASSAGE.z1 - PASSAGE.z0) / 2, 0, 2.3, 6.2);

  // Courtyard ground (ash-drifted) at sidewalk height.
  const courtW = COURT.x1 - COURT.x0;
  const courtD = COURT.z1 - COURT.z0;
  const courtMat = new THREE.MeshStandardMaterial({ roughness: 1 });
  applyPBR(courtMat, makeAshDrift(9));
  patchAsh(courtMat, 1.8);
  extraMats.push(courtMat);
  const courtGeo = new THREE.PlaneGeometry(courtW, courtD).rotateX(-Math.PI / 2);
  extraGeos.push(courtGeo);
  const courtGroundMesh = new THREE.Mesh(courtGeo, courtMat);
  courtGroundMesh.position.set((COURT.x0 + COURT.x1) / 2, FLAT_FLOOR_Y, (COURT.z0 + COURT.z1) / 2);
  courtGroundMesh.receiveShadow = true;
  group.add(courtGroundMesh);
  // Passage floor strip from the sidewalk into the courtyard.
  const passGeo = new THREE.PlaneGeometry(PASSAGE.x1 - PASSAGE.x0, PASSAGE.z1 - PASSAGE.z0).rotateX(-Math.PI / 2);
  extraGeos.push(passGeo);
  const passFloor = new THREE.Mesh(passGeo, courtMat);
  passFloor.position.set(-16, FLAT_FLOOR_Y + 0.002, (PASSAGE.z0 + PASSAGE.z1) / 2);
  passFloor.receiveShadow = true;
  group.add(passFloor);

  // Courtyard perimeter walls (h 3) — east side is the building backs.
  const wallH = 3;
  const wallGeoW = new THREE.BoxGeometry(0.24, wallH, courtD);
  const wallGeoNS = new THREE.BoxGeometry(courtW, wallH, 0.24);
  extraGeos.push(wallGeoW, wallGeoNS);
  const westWall = new THREE.Mesh(wallGeoW, plasterMat);
  westWall.position.set(COURT.x0, wallH / 2, (COURT.z0 + COURT.z1) / 2);
  const northWall = new THREE.Mesh(wallGeoNS, plasterMat);
  northWall.position.set((COURT.x0 + COURT.x1) / 2, wallH / 2, COURT.z1);
  const southWall = new THREE.Mesh(wallGeoNS, plasterMat);
  southWall.position.set((COURT.x0 + COURT.x1) / 2, wallH / 2, COURT.z0);
  for (const w of [westWall, northWall, southWall]) {
    w.castShadow = true;
    w.receiveShadow = true;
    group.add(w);
  }
  colliders.addBox(COURT.x0, (COURT.z0 + COURT.z1) / 2, 0.15, courtD / 2);
  colliders.addBox((COURT.x0 + COURT.x1) / 2, COURT.z1, courtW / 2, 0.15);
  colliders.addBox((COURT.x0 + COURT.x1) / 2, COURT.z0, courtW / 2, 0.15);

  // Bike shed (lean-to) + waste containers + dead tree.
  const woodMat = new THREE.MeshStandardMaterial({ color: '#4a4238', roughness: 0.9 });
  patchAsh(woodMat, 0.6);
  extraMats.push(woodMat);
  const shedRoofMat = new THREE.MeshStandardMaterial({ color: '#3c4043', roughness: 0.7, metalness: 0.4 });
  patchAsh(shedRoofMat, 1.6);
  extraMats.push(shedRoofMat);
  const shed = new THREE.Group();
  const postPositions = [
    [-1.6, -0.9],
    [1.6, -0.9],
    [-1.6, 0.9],
    [1.6, 0.9],
  ] as const;
  const postGeo = mergeGeos(
    postPositions.map(([px, pz]) => new THREE.BoxGeometry(0.08, 1.9, 0.08).translate(px, 0.95, pz)),
  );
  extraGeos.push(postGeo);
  const posts = new THREE.Mesh(postGeo, woodMat);
  posts.castShadow = true;
  shed.add(posts);
  const roofGeo = new THREE.BoxGeometry(3.6, 0.06, 2.2);
  extraGeos.push(roofGeo);
  const shedRoof = new THREE.Mesh(roofGeo, shedRoofMat);
  shedRoof.position.set(0, 1.92, 0);
  shedRoof.rotation.z = 0.1;
  shedRoof.castShadow = true;
  shedRoof.receiveShadow = true;
  shed.add(shedRoof);
  const shedBikes = buildBikeHeap(8, 1.4, 0.8, 33);
  shedBikes.position.set(0, 0, 0);
  shed.add(shedBikes);
  shed.position.set(COURT.x0 + 2.2, FLAT_FLOOR_Y, COURT.z1 - 1.6);
  group.add(shed);
  colliders.addBox(COURT.x0 + 2.2, COURT.z1 - 1.6, 1.7, 1.1);

  const binMat = new THREE.MeshStandardMaterial({ color: '#4e5a52', roughness: 0.6, metalness: 0.3 });
  patchAsh(binMat, 1.2);
  extraMats.push(binMat);
  const binGeo = mergeGeos(
    [0, 1].map((i) =>
      new THREE.BoxGeometry(1.2, 1.35, 1.0)
        .rotateY(i * 0.18 - 0.05)
        .translate(COURT.x0 + 1.0 + i * 1.5, FLAT_FLOOR_Y + 1.35 / 2, COURT.z0 + 1.0),
    ),
  );
  extraGeos.push(binGeo);
  const bins = new THREE.Mesh(binGeo, binMat);
  bins.castShadow = true;
  bins.receiveShadow = true;
  group.add(bins);
  for (let i = 0; i < 2; i++) {
    colliders.addBox(COURT.x0 + 1.0 + i * 1.5, COURT.z0 + 1.0, 0.65, 0.55, i * 0.18 - 0.05);
  }

  const treeMat = new THREE.MeshStandardMaterial({ color: '#2e2c28', roughness: 1 });
  patchAsh(treeMat, 0.8);
  extraMats.push(treeMat);
  const treeGeos: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.07, 0.13, 3.0, 7).translate(0, 1.5, 0)];
  const branchSpecs = [
    [0.5, 2.2, 0.5, 1.1],
    [-0.6, 2.5, -0.3, 0.9],
    [0.2, 2.8, -0.5, 0.8],
    [-0.3, 1.9, 0.4, 0.7],
    [0.05, 3.0, 0.1, 0.6],
  ];
  for (const [bx, by, bz, bl] of branchSpecs) {
    const b = new THREE.CylinderGeometry(0.02, 0.045, bl, 5);
    b.translate(0, bl / 2, 0);
    b.rotateZ(bx * 1.2);
    b.rotateX(bz * 1.4);
    b.translate(0, by, 0);
    treeGeos.push(b);
  }
  const treeGeo = mergeGeos(treeGeos);
  extraGeos.push(treeGeo);
  const tree = new THREE.Mesh(treeGeo, treeMat);
  tree.position.set(-27.5, FLAT_FLOOR_Y, 10.5);
  tree.castShadow = true;
  group.add(tree);
  colliders.addBox(-27.5, 10.5, 0.22, 0.22);

  // ---------------------------------------------------------------------
  // Candle flat (right block 1, behind the shopfront)
  // ---------------------------------------------------------------------
  const flat = buildCandleFlat({
    width: 6,
    depth: 5,
    doorOffset: 0,
    windowOffsets: [-1.8, 1.8],
    seed: 41,
  });
  flat.group.rotation.y = FLAT_ROT;
  flat.group.position.set(FLAT_CENTER_X, FLAT_FLOOR_Y, FLAT_CENTER_Z);
  // Indoors the sun never reaches: sun-shadow casting is pure draw cost.
  flat.group.traverse((obj) => {
    (obj as THREE.Mesh).castShadow = false;
  });
  group.add(flat.group);
  for (const d of flat.colliders) {
    colliders.addBox(FLAT_CENTER_X - d.cz, FLAT_CENTER_Z + d.cx, d.hx, d.hz, d.yaw + FLAT_ROT);
  }

  // ---- Player-area caps (M2 boundary) ----
  colliders.addBox(0, 41.2, 12, 0.4); // north: junction is backdrop until M4
  colliders.addBox(0, -150.5, 12, 0.4); // south: fog edge

  // ---- Ground heights: sidewalk plateaus, courtyard, passage, flat ----
  colliders.addHeightFn((x, z) => {
    // Main-street sidewalks with a smooth curb ramp (5.55 → 5.85).
    if (z > -160 && z < 42) {
      const ax = Math.abs(x);
      if (ax > 5.55 && ax < BUILDING_LINE + 0.2) {
        const t = Math.min(1, Math.max(0, (ax - 5.55) / 0.3));
        return 0.13 * t * t * (3 - 2 * t);
      }
    }
    return null;
  });
  colliders.addHeightFn((x, z) => {
    if (x >= COURT.x0 && x <= COURT.x1 && z >= COURT.z0 && z <= COURT.z1) return FLAT_FLOOR_Y;
    if (x >= PASSAGE.x0 && x <= PASSAGE.x1 && z >= PASSAGE.z0 && z <= PASSAGE.z1) return FLAT_FLOOR_Y;
    if (x >= FLAT_EXIT.x0 && x <= FLAT_EXIT.x1 + 0.2 && z >= FLAT_EXIT.z0 && z <= FLAT_EXIT.z1) {
      return FLAT_FLOOR_Y;
    }
    return null;
  });

  // ---------------------------------------------------------------------
  // Sky, sun, ash, god rays
  // ---------------------------------------------------------------------
  const sky = new SkySystem();
  const sunDir0 = getSunDirection(act1.sun);
  sky.applyConfig(act1.sky, sunDir0);
  group.add(sky.mesh);

  const sunRig = new SunRig(qualityManager.current.shadowMapSize);
  sunRig.applyConfig(act1);
  group.add(sunRig.group);

  const ash = new AshParticles({
    count: Math.floor(act1.ash.count * qualityManager.current.particleMultiplier),
  });
  ash.setWind(act1.ash.wind[0], act1.ash.wind[1], act1.ash.wind[2]);
  group.add(ash.points);

  const godRaysSource = new THREE.Mesh(
    new THREE.CircleGeometry(30, 32),
    new THREE.MeshBasicMaterial({
      color: act1.sky.sunDiscColor,
      transparent: true,
      opacity: 0.85,
      fog: false,
      depthWrite: false,
    }),
  );
  godRaysSource.name = 'god-rays-source';
  godRaysSource.renderOrder = -999;
  godRaysSource.frustumCulled = false;
  group.add(godRaysSource);

  // ---------------------------------------------------------------------
  // Actors
  // ---------------------------------------------------------------------
  const ellen = new HumanoidActor({
    height: 1.72,
    coatColor: '#4d5052',
    hoodColor: '#3f4244',
    scarfColor: '#5a4f42',
    seed: 1,
  });
  group.add(ellen.group);
  const player = new PlayerController(ellen, engine.camera, input, colliders);

  const jonasActor = new HumanoidActor({
    height: 1.78,
    build: 0.25,
    coatColor: '#565349',
    hoodColor: '#4a473f',
    scarfColor: '#3f4347',
    seed: 2,
  });
  group.add(jonasActor.group);
  // Slot clears the over-shoulder camera wedge (boom 3.4 m behind-right):
  // wider and further back than the spec sketch or Jonas looms in frame.
  const jonas = new Follower(jonasActor, {
    offsetBack: 2.1,
    offsetSide: -1.5,
    maxSpeed: 3.0,
    radius: 0.3,
  });

  const birkActor = new DogActor({ seed: 3 });
  group.add(birkActor.group);
  const birk = new Follower(birkActor, {
    offsetBack: 1.0,
    offsetSide: 1.1,
    maxSpeed: 4.0,
    radius: 0.25,
  });

  // Shared separation array (each follower skips its own entry by identity).
  const others: THREE.Vector3[] = [jonas.position, birk.position];

  // ---------------------------------------------------------------------
  // Scene lifecycle
  // ---------------------------------------------------------------------
  // Exposure adaptation at the flat threshold (§6.8): hysteresis between
  // enter/exit rects, setExposure only on state change. The zone's .inside
  // doubles as the indoors/heat flag for the meters + beats.
  const triggers = new TriggerSet();
  const flatZone = triggers.add({
    enter: FLAT_ENTER,
    exit: FLAT_EXIT,
    onEnter: () => post.setExposure(EXPOSURE_INTERIOR),
    onExit: () => post.setExposure(act1.exposure),
  });

  // ---------------------------------------------------------------------
  // M3 systems wiring
  // ---------------------------------------------------------------------
  const radiation = new RadiationField(RAD_SOURCES);
  const meterEnv: MeterEnv = { indoors: false, nearHeat: false, radiation: 0, radioOn: false };
  const hudInfo = { geigerRate: 0 }; // persistent scratch (no per-frame alloc)
  const beats = new Act1Beats({
    state,
    dialogue,
    radio,
    autosave: () =>
      save.save('act1', { x: player.position.x, z: player.position.z, yaw: player.heading }),
  });

  // Meter-recovery pickups (close the survival loop): a battery in the flat,
  // a mask filter out in the courtyard by the shed.
  const pickups = new PickupSet(state, meters, sfx, 'act1');
  pickups.add({ id: 'flat-battery', kind: 'battery', x: 11.9, z: 23.4, y: 0.33 });
  pickups.add({ id: 'court-filter', kind: 'filter', x: -30.5, z: 12.6, y: 0.33 });

  function applyActConfig(): void {
    worldUniforms.uFogColor.value.set(act1.fog.color);
    worldUniforms.uFogDensity.value = act1.fog.density;
    worldUniforms.uHeightFogDensity.value = act1.fog.heightDensity;
    worldUniforms.uHeightFogFalloff.value = act1.fog.heightFalloff;
    worldUniforms.uHeightFogOffset.value = act1.fog.heightOffset;
    worldUniforms.uFogNoiseAmount.value = act1.fog.noiseAmount;
    worldUniforms.uAshLevel.value = act1.ash.level;
    engine.scene.background = null;
  }

  return {
    id: 'act1',
    player,
    godRaysSource,

    load(): void {
      applyActConfig();
      engine.scene.add(group);
      engine.scene.add(pickups.group);
      engine.scene.environment = sky.buildEnvironment(engine.renderer);
      engine.scene.environmentIntensity = 0.85;
      post.setExposure(act1.exposure, true);
      player.spawn(1.2, 34, Math.PI);
      jonas.warpToSlot(player.position, player.heading);
      birk.warpToSlot(player.position, player.heading);
      triggers.reset();
      beats.reset();
      radio.setSignals(buildAct1Signals(player));
      hud.setVisible(true);
      hud.setPrompt(null);
    },

    applyQuality(q): void {
      sunRig.setShadowMapSize(q.shadowMapSize);
      ash.setDensity(q.particleMultiplier);
    },

    update(dt: number, elapsed: number): void {
      worldUniforms.uTime.value = elapsed;
      player.update(dt, elapsed);
      jonas.update(dt, elapsed, player.position, player.heading, colliders, others);
      birk.update(dt, elapsed, player.position, player.heading, colliders, others);
      sky.update(dt, elapsed);
      ash.update(dt, elapsed, engine.camera);
      sunRig.followTarget(player.position);
      updateCityFlicker(blocks, elapsed);
      for (const rig of flat.candles) rig.update(dt, elapsed);
      godRaysSource.position
        .copy(engine.camera.position)
        .addScaledVector(sunRig.sunDir, -GOD_RAYS_DISTANCE);
      godRaysSource.lookAt(engine.camera.position);

      triggers.update(player.position.x, player.position.z);

      // ---- M3 systems (player position drives everything) ----
      const px = player.position.x;
      const pz = player.position.z;
      const insideFlat = flatZone.inside;

      // Held radio tuning (Arrow keys; movement stays on WASD).
      if (state.radio.on) {
        if (input.pressed('ArrowLeft')) radio.tune(-1, dt);
        if (input.pressed('ArrowRight')) radio.tune(1, dt);
      }
      radio.update(dt, px, pz);

      const rad = radiation.sampleAt(px, pz);
      geiger.update(dt, rad);

      meterEnv.indoors = insideFlat;
      meterEnv.nearHeat = insideFlat; // the candle flat is the only warm room
      meterEnv.radiation = rad;
      meterEnv.radioOn = state.radio.on;
      meters.update(dt, meterEnv);

      dialogue.update(dt);
      beats.update(dt, px, pz, rad, insideFlat);
      pickups.update(dt, px, pz);

      // Centre prompt: silent during dialogue; pickup-in-reach beats the
      // (one-time) "turn the radio on" hint when both want the line.
      let prompt: string | null = null;
      if (!dialogue.active) prompt = pickups.promptText ?? (beats.wantsRadioPrompt ? 'R — TÆND RADIOEN' : null);
      hud.setPrompt(prompt);

      hudInfo.geigerRate = geiger.displayRate;
      hud.update(dt, hudInfo);
      radioOverlay.update(dt, radio.signalLevel);
      journal.setPlayerPos(px, pz, player.heading);
      journal.update(dt);
    },

    interact(): void {
      const r = pickups.interact();
      if (r?.first && !dialogue.active) {
        dialogue.play([
          {
            speaker: 'ELLEN',
            text:
              r.kind === 'battery'
                ? 'Et batteri. Radioen lever lidt endnu.'
                : 'Et filter. Det kan redde Jonas’ lunger.',
          },
        ]);
      }
    },

    dispose(): void {
      engine.scene.remove(group);
      engine.scene.remove(pickups.group);
      pickups.dispose();
      group.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh || (obj as THREE.Points).isPoints) {
          const mesh = obj as THREE.Mesh;
          mesh.geometry.dispose();
          const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) {
            for (const m of mat) m.dispose();
          } else {
            mat?.dispose();
          }
        }
      });
      flat.dispose();
      ellen.dispose();
      jonasActor.dispose();
      birkActor.dispose();
      for (const g of extraGeos) g.dispose();
      for (const m of extraMats) m.dispose();
      sky.dispose();
      sunRig.dispose();
      ash.dispose();
      colliders.clear();
      if (engine.scene.environment) {
        engine.scene.environment.dispose();
        engine.scene.environment = null;
      }
      disposeAllGeneratedTextures();
      post.setExposure(act1.exposure, true);
    },
  };
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------
/** Merge + free the sources (build-time only). */
function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged;
}

function patchAsh(mat: THREE.MeshStandardMaterial, ashAmount: number): void {
  patchWorldMaterial(mat, { ashAmount });
}
