import * as THREE from 'three';
import type { Engine } from '../core/engine';
import { AshParticles } from '../graphics/ashParticles';
import { SkySystem } from '../graphics/sky';
import { SunRig } from '../graphics/lights';
import { ACT_CONFIGS, getSunDirection } from '../graphics/palette';
import type { ActLookConfig } from '../graphics/palette';
import { worldUniforms } from '../graphics/worldMaterial';
import { qualityManager } from '../core/quality';
import {
  buildFacadeBlock,
  buildSkylineCards,
  buildStreetGround,
  updateCityFlicker,
} from '../world/cityKit';
import type { FacadeParams } from '../world/cityKit';
import {
  buildAbandonedCars,
  buildBikeHeap,
  buildLampPosts,
  buildPaintedSign,
  buildRubblePiles,
} from '../world/props';
import type { CarPlacement } from '../world/props';
import { disposeAllGeneratedTextures } from '../world/textures';

/**
 * M1 look-dev street (§10.3): one Nordvest street at noon on Day 14.
 * This scene DEFINES the game's look — a moody, ash-choked Copenhagen
 * street dissolving into fog toward a pale sun disc.
 *
 * Composition (street runs along Z, camera looks toward -Z):
 * - Camera spawn: (1.2, 1.7, 28) looking down-street, askesol low ahead.
 * - Façade blocks both sides, ash drifts in gutters, stranded cars in a
 *   loose queue, a bike heap, lamp posts, a hand-painted Danish sign,
 *   skyline silhouettes beyond, 40k falling ash particles, layered fog.
 * - A few candle-lit windows; everything else is cold.
 *
 * CONTRACT: buildLookdevScene adds everything to engine.scene, applies
 * ACT_CONFIGS.act1 (incl. scene.environment via sky.buildEnvironment),
 * and returns handles + a per-frame update.
 */
export interface LookdevScene {
  group: THREE.Group;
  sky: SkySystem;
  sunRig: SunRig;
  ash: AshParticles;
  /** Emissive disc aligned with the sun, for GodRaysEffect. */
  godRaysSource: THREE.Mesh;
  update(dt: number, elapsed: number, camera: THREE.PerspectiveCamera): void;
  dispose(): void;
}

// Street layout constants (road 11 m wide -> curbs at ±5.5, sidewalks to ±10).
const BUILDING_LINE = 10;
const FACADE_BODY_DEPTH = 12;
const ALLEY_GAP = 2.5;
const GOD_RAYS_DISTANCE = 820; // inside the 1200 m far plane, beyond skyline cards

// Module scratch — update() must not allocate.
const _box = new THREE.Box3();

function applyActConfig(engine: Engine, cfg: ActLookConfig): void {
  worldUniforms.uFogColor.value.set(cfg.fog.color);
  worldUniforms.uFogDensity.value = cfg.fog.density;
  worldUniforms.uHeightFogDensity.value = cfg.fog.heightDensity;
  worldUniforms.uHeightFogFalloff.value = cfg.fog.heightFalloff;
  worldUniforms.uHeightFogOffset.value = cfg.fog.heightOffset;
  worldUniforms.uFogNoiseAmount.value = cfg.fog.noiseAmount;
  worldUniforms.uAshLevel.value = cfg.ash.level;
  // The sky dome IS the backdrop; scene.background must not paint over it.
  engine.scene.background = null;
}

/**
 * Place façade blocks in a row along Z on one side of the street.
 *
 * Rotation math: a rotation θ about Y maps the block's local +Z (its front
 * face) to world (sinθ, 0, cosθ).
 *   LEFT side (x<0): front must face world +X  → sinθ = 1, cosθ = 0 → θ = +π/2.
 *   RIGHT side (x>0): front must face world −X → sinθ = −1, cosθ = 0 → θ = −π/2.
 * The same rotation maps local +X (façade width axis) onto world ∓Z, so the
 * measured local-X width becomes the block's footprint along the street.
 *
 * Position: body depth 12 and front plane at local z = +6, so a centre at
 * x = ±(10 + 6) = ±16 puts the front plane exactly on the building line:
 *   left  −16 + 6 = −10, right +16 − 6 = +10. ✓
 */
function placeFacadeRow(
  side: -1 | 1,
  specs: FacadeParams[],
  zStart: number,
  parent: THREE.Group,
  blocks: THREE.Group[],
): number {
  const rotY = side < 0 ? Math.PI / 2 : -Math.PI / 2;
  const centerX = side * (BUILDING_LINE + FACADE_BODY_DEPTH / 2);
  let zCursor = zStart;
  for (const params of specs) {
    const block = buildFacadeBlock(params);
    // Measure the unrotated block: local X extent = façade width.
    _box.setFromObject(block);
    const width = _box.max.x - _box.min.x;
    block.rotation.y = rotY;
    block.position.set(centerX, 0, zCursor - width / 2);
    parent.add(block);
    blocks.push(block);
    zCursor -= width + ALLEY_GAP;
  }
  return zCursor;
}

export function buildLookdevScene(engine: Engine): LookdevScene {
  const act1 = ACT_CONFIGS.act1;
  const group = new THREE.Group();
  group.name = 'lookdev-street';

  applyActConfig(engine, act1);

  // ---- Sky + IBL ----
  const sky = new SkySystem();
  const sunDir0 = getSunDirection(act1.sun);
  sky.applyConfig(act1.sky, sunDir0);
  group.add(sky.mesh);
  engine.scene.environment = sky.buildEnvironment(engine.renderer);
  engine.scene.environmentIntensity = 0.85; // keep IBL subtle under heavy fog

  // ---- Sun + hemisphere rig ----
  const sunRig = new SunRig(qualityManager.current.shadowMapSize);
  sunRig.applyConfig(act1);
  group.add(sunRig.group);

  // ---- Street ground (runs along Z) ----
  group.add(buildStreetGround(220, 11, 4.5));

  // ---- Façades: 3 blocks per side, staggered lengths so seams never align
  // across the street; one brick per side; shopfronts + candle-lit windows
  // only on the two blocks nearest the camera (z ≈ +10..+30). ----
  const blocks: THREE.Group[] = [];
  placeFacadeRow(
    -1,
    [
      { bays: 8, floors: 5, style: 'plaster', tint: '#8a8068', seed: 11, shopfront: true, litWindows: 3 },
      { bays: 10, floors: 5, style: 'brick', tint: '#6e5d52', seed: 12 },
      { bays: 7, floors: 5, style: 'plaster', tint: '#767a70', seed: 13 },
    ],
    32,
    group,
    blocks,
  );
  placeFacadeRow(
    1,
    [
      { bays: 9, floors: 5, style: 'plaster', tint: '#87726a', seed: 21, shopfront: true, litWindows: 2 },
      { bays: 7, floors: 5, style: 'plaster', tint: '#767a70', seed: 22 },
      { bays: 10, floors: 5, style: 'brick', tint: '#6e5d52', seed: 23 },
    ],
    36,
    group,
    blocks,
  );
  // One more pair deep in the fog (z < −110), unlit — silhouettes only.
  placeFacadeRow(
    -1,
    [{ bays: 9, floors: 5, style: 'plaster', tint: '#8a8068', seed: 31, litWindows: 0 }],
    -112,
    group,
    blocks,
  );
  placeFacadeRow(
    1,
    [{ bays: 8, floors: 5, style: 'plaster', tint: '#87726a', seed: 32, litWindows: 0 }],
    -115,
    group,
    blocks,
  );

  // ---- Cars: a loose abandoned queue heading OUT of the city (toward −Z)
  // in the right lane, 9–14 m gaps with jitter, two slewed mid-manoeuvre,
  // one contraflow car on the left lane facing +Z. Variants cycled. ----
  const carPlacements: CarPlacement[] = [
    { x: 2.55, z: 18.0, yaw: Math.PI + 0.04, variant: 0 },
    { x: 2.7, z: 4.1, yaw: Math.PI - 0.05, variant: 1 },
    { x: 2.5, z: -9.1, yaw: Math.PI + 0.02, variant: 2 },
    { x: 2.9, z: -23.1, yaw: Math.PI + 0.5, variant: 0 }, // slewed across the lane
    { x: 2.6, z: -35.7, yaw: Math.PI - 0.03, variant: 1 },
    { x: 2.45, z: -49.1, yaw: Math.PI + 0.06, variant: 2 },
    { x: 3.0, z: -63.1, yaw: Math.PI - 0.5, variant: 0 }, // slewed the other way
    { x: 2.6, z: -76.6, yaw: Math.PI - 0.02, variant: 1 },
    { x: 2.5, z: -90.6, yaw: Math.PI + 0.05, variant: 2 },
    { x: -2.6, z: -42.0, yaw: 0.08, variant: 0 }, // came the other way, left lane
  ];
  group.add(buildAbandonedCars(carPlacements, 4));

  // ---- Bike heaps ----
  const bigHeap = buildBikeHeap(38, 3, 1.8, 7);
  bigHeap.position.set(-8, 0, 10);
  group.add(bigHeap);
  const smallHeap = buildBikeHeap(12, 1.8, 1.2, 19);
  smallHeap.position.set(8.2, 0, -30);
  group.add(smallHeap);

  // ---- Lamp posts: both sides at x = ±9.6, every 24 m, sides staggered by
  // half a step. Arms must overhang the road, so the right-side group is the
  // left-side layout rotated π about Y (maps (x,z) → (−x,−z) and flips the
  // arm direction across the street). ----
  const lampZsLeft = [40, 16, -8, -32, -56, -80, -104, -128];
  const lampZsRight = [28, 4, -20, -44, -68, -92, -116, -140];
  const leftPosts = buildLampPosts(lampZsLeft.map((z) => ({ x: -9.6, z })));
  group.add(leftPosts);
  const rightPosts = buildLampPosts(lampZsRight.map((z) => ({ x: -9.6, z: -z })));
  rightPosts.rotation.y = Math.PI; // (−9.6, −z) → (+9.6, +z), arm mirrored over road
  group.add(rightPosts);

  // ---- Hand-painted sign, facing up-street toward the camera spawn ----
  const sign = buildPaintedSign(['DER ER IKKE MERE', 'GÅ MOD ROSKILDE']);
  sign.position.set(8, 0, 2);
  sign.rotation.y = -0.4; // local +Z → (−0.39, 0, 0.92): toward camera at (1.2, _, 28)
  group.add(sign);

  // ---- Rubble piles against the façades ----
  group.add(
    buildRubblePiles(
      [
        { x: -9.2, z: -55, radius: 1.5, height: 0.5 },
        { x: 9.1, z: -18, radius: 1.1, height: 0.4 },
        { x: -9.0, z: -120, radius: 1.8, height: 0.6 },
      ],
      5,
    ),
  );

  // ---- Distant skyline silhouettes ----
  group.add(buildSkylineCards(380));

  // ---- Falling ash ----
  const ash = new AshParticles({
    count: Math.floor(act1.ash.count * qualityManager.current.particleMultiplier),
  });
  ash.setWind(act1.ash.wind[0], act1.ash.wind[1], act1.ash.wind[2]);
  group.add(ash.points);

  // ---- God-rays light source: per postprocessing's GodRaysEffect contract
  // the mesh "must not write depth and has to be flagged as transparent".
  // It doubles as the visible askesol core; drawn right after the sky dome
  // (renderOrder −999 vs the dome's −1000) and glued to the camera in
  // update() so it always sits exactly on the sun axis. ----
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
  godRaysSource.position
    .copy(engine.camera.position)
    .addScaledVector(sunDir0, -GOD_RAYS_DISTANCE);
  godRaysSource.lookAt(engine.camera.position);
  group.add(godRaysSource);

  engine.scene.add(group);

  // ---- Per-frame update (zero allocations) ----
  function update(dt: number, elapsed: number, camera: THREE.PerspectiveCamera): void {
    worldUniforms.uTime.value = elapsed;
    sky.update(dt, elapsed);
    ash.update(dt, elapsed, camera);
    sunRig.followTarget(camera.position);
    updateCityFlicker(blocks, elapsed);
    // sunRig.sunDir tracks live GUI changes, so the disc follows re-aimed suns.
    godRaysSource.position
      .copy(camera.position)
      .addScaledVector(sunRig.sunDir, -GOD_RAYS_DISTANCE);
    godRaysSource.lookAt(camera.position);
  }

  function dispose(): void {
    engine.scene.remove(group);
    // Free every geometry/material created under the scene group. Material
    // textures are owned by the texture registry, freed below; double
    // dispose of shared resources is harmless (three guards internally).
    group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh || (obj as THREE.Points).isPoints) {
        const anyObj = obj as THREE.Mesh;
        anyObj.geometry.dispose();
        const mat = anyObj.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) {
          for (const m of mat) m.dispose();
        } else {
          mat?.dispose();
        }
      }
    });
    sky.dispose();
    sunRig.dispose();
    ash.dispose();
    if (engine.scene.environment) {
      engine.scene.environment.dispose();
      engine.scene.environment = null;
    }
    disposeAllGeneratedTextures();
  }

  return { group, sky, sunRig, ash, godRaysSource, update, dispose };
}
