import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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
import { worldUniforms, patchWorldMaterial } from '../graphics/worldMaterial';
import { qualityManager } from '../core/quality';
import { mulberry32, clamp } from '../core/math';
import {
  applyPBR,
  makeAsphalt,
  makeAshDrift,
  makeSidewalk,
  makeMetalPainted,
  disposeAllGeneratedTextures,
  type PBRSet,
} from '../world/textures';
import { buildAbandonedCars, buildRubblePiles, buildPaintedSign, type CarPlacement } from '../world/props';
import { buildSkylineCards } from '../world/cityKit';
import type { GameSystems } from '../systems/gameSystems';
import type { MeterEnv } from '../systems/meters';
import { RadiationField, type RadiationSource } from '../systems/geiger';
import type { RadioSignal } from '../systems/radio';
import { RoadBeats } from '../story/roadBeats';

/**
 * Interlude A — the road out of København (the 'RoadA' scene in the
 * Title→Act1→RoadA→Act2 chain). An open two-lane landevej running along −Z
 * toward Roskilde and the low sun, ash blanketing the fields either side,
 * receding power-line poles and a broken guardrail as leading lines into
 * the fog, abandoned cars, a burned-out wreck (a radiation hot zone). The
 * contrast with the Act-I street canyon is the point: nothing but distance.
 *
 * Reuses the M1/M2 world kit + all M3 systems via GameSystems. Player area
 * is the road corridor (x ∈ [−5.5, 5.5], z ∈ [−250, 58]); the far fog edge
 * is the seam to Act II.
 */

const ROAD_HALF = 4; // asphalt half-width (2 lanes)
const Z_START = 58; // behind (city side)
const Z_END = -252; // ahead (fog / Act II seam)
const ROAD_LEN = Z_START - Z_END;
const ROAD_MID = (Z_START + Z_END) / 2;
const CORRIDOR = 5.5; // player collision half-width
const GOD_RAYS_DISTANCE = 820;
const POLE_X = -9;
const RAIL_X = 6;

// Burned tanker wreck — the interlude's single radiation hot zone (§4).
const RAD_SOURCES: RadiationSource[] = [{ x: 2.6, z: -118, radius: 12, intensity: 0.85 }];

// ROSKILDE morse + a faint voice band; both strengthen as Ellen walks the
// road (progress = how far down −Z), and read cleaner here than in the city.
function buildRoadSignals(player: PlayerController): RadioSignal[] {
  const progress = (): number => clamp((Z_START - player.position.z) / (ROAD_LEN - 20), 0, 1);
  return [
    {
      freq: 96.4,
      bandwidth: 0.55,
      kind: 'morse',
      message: 'ROSKILDE',
      strengthAt: () => 0.55 + 0.45 * progress(),
    },
    {
      freq: 101.7,
      bandwidth: 0.5,
      kind: 'voice',
      strengthAt: () => 0.3 + 0.35 * progress(),
    },
  ];
}

export function createRoadA(
  engine: Engine,
  input: Input,
  post: PostStack,
  deps: GameSystems,
): GameScene {
  const cfg = ACT_CONFIGS.act1; // Interlude shares Act-I's overcast ash look.
  const { state, meters, geiger, radio, dialogue, hud, radioOverlay, journal, save } = deps;
  const group = new THREE.Group();
  group.name = 'roadA';
  const colliders = new ColliderWorld();
  const extraGeos: THREE.BufferGeometry[] = [];
  const extraMats: THREE.Material[] = [];

  // -- ground plane helper: UVs in metres/tile (textures are shared; never
  //    touch their .repeat), patched for ash + fog like every world surface.
  function groundPlane(w: number, d: number, tile: number, set: PBRSet, ash: number, y: number, x: number, z: number): void {
    const geo = new THREE.PlaneGeometry(w, d);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / tile), uv.getY(i) * (d / tile));
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ roughness: 1 });
    applyPBR(mat, set);
    patchWorldMaterial(mat, { ashAmount: ash });
    extraGeos.push(geo);
    extraMats.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Asphalt (partly readable — drifts gather at the edges), gravel shoulders,
  // ash-buried fields running far out to the fog.
  groundPlane(2 * ROAD_HALF, ROAD_LEN, 6, makeAsphalt(11), 1.25, 0.02, 0, ROAD_MID);
  groundPlane(3, ROAD_LEN, 2.4, makeSidewalk(23), 1.7, 0.012, -ROAD_HALF - 1.4, ROAD_MID);
  groundPlane(3, ROAD_LEN, 2.4, makeSidewalk(23), 1.7, 0.012, ROAD_HALF + 1.4, ROAD_MID);
  groundPlane(64, ROAD_LEN, 3, makeAshDrift(9), 1.85, 0, -ROAD_HALF - 1.5 - 32, ROAD_MID);
  groundPlane(64, ROAD_LEN, 3, makeAshDrift(9), 1.85, 0, ROAD_HALF + 1.5 + 32, ROAD_MID);

  // -- merged-geometry kit helpers -----------------------------------------
  function mergeInto(geos: THREE.BufferGeometry[], mat: THREE.Material): void {
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    extraGeos.push(merged);
    extraMats.push(mat);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Power line: wooden poles + crossarms one side, two sagging wires per gap.
  // The receding rhythm carries the eye into the fog — but irregular spacing,
  // a slight per-pole lean, one toppled pole and a couple of snapped spans
  // keep it from reading as a tidy game fence (post-fall, not freshly built).
  function buildPowerLine(): void {
    const woodMat = new THREE.MeshStandardMaterial({ color: '#3b342c', roughness: 0.95 });
    patchWorldMaterial(woodMat, { ashAmount: 0.5 });
    const wireMat = new THREE.MeshStandardMaterial({ color: '#181a1b', roughness: 1 });
    patchWorldMaterial(wireMat, { ashAmount: 0 });
    const poleGeos: THREE.BufferGeometry[] = [];
    const wireGeos: THREE.BufferGeometry[] = [];
    const r = mulberry32(91);
    const poleH = 7;
    const armY = 6.2;
    const tip = 1.15;
    // Irregular spacing + per-pole x/lean; mark one toppled, a couple of dead
    // spans (snapped wires).
    const poles: Array<{ x: number; z: number; lean: number; down: boolean }> = [];
    for (let z = Z_START - 6; z > Z_END + 8; z -= 21 + r() * 8) {
      poles.push({ x: POLE_X + (r() * 2 - 1) * 0.5, z, lean: (r() * 2 - 1) * 0.05, down: false });
    }
    const fallen = 2 + Math.floor(r() * (poles.length - 4));
    poles[fallen].down = true;
    const deadSpan = new Set<number>([fallen - 1, fallen, 1 + Math.floor(r() * (poles.length - 3))]);

    for (let i = 0; i < poles.length; i++) {
      const p = poles[i];
      if (p.down) {
        // Toppled into the field: a leaning snapped stump + the pole on the ground.
        poleGeos.push(new THREE.CylinderGeometry(0.1, 0.14, 1.4, 7).translate(p.x, 0.7, p.z));
        const lain = new THREE.CylinderGeometry(0.1, 0.13, 6, 7);
        lain.rotateX(Math.PI / 2 - 0.12);
        lain.rotateZ(0.3);
        lain.translate(p.x - 2.4, 0.3, p.z - 2.6);
        poleGeos.push(lain);
        continue;
      }
      const pole = new THREE.CylinderGeometry(0.1, 0.14, poleH, 7);
      const arm = new THREE.BoxGeometry(2.5, 0.12, 0.12).translate(0, armY - poleH / 2, 0);
      for (const g of [pole, arm]) {
        g.rotateZ(p.lean);
        g.translate(p.x, poleH / 2, p.z);
        poleGeos.push(g);
      }
    }
    for (let i = 0; i < poles.length - 1; i++) {
      if (deadSpan.has(i)) continue;
      const a = poles[i];
      const b = poles[i + 1];
      if (a.down || b.down) continue;
      const zmid = (a.z + b.z) / 2;
      const xmid = (a.x + b.x) / 2;
      const sag = 0.55;
      for (const side of [-tip, tip]) {
        wireGeos.push(wireSeg(a.x + side, armY, a.z, xmid + side, armY - sag, zmid));
        wireGeos.push(wireSeg(xmid + side, armY - sag, zmid, b.x + side, armY, b.z));
      }
    }
    mergeInto(poleGeos, woodMat);
    if (wireGeos.length > 0) mergeInto(wireGeos, wireMat);
  }
  // Thin wire cylinder between two world points.
  function wireSeg(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): THREE.BufferGeometry {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    const g = new THREE.CylinderGeometry(0.022, 0.022, len, 4);
    // align +Y to the segment
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(dx / len, dy / len, dz / len),
    );
    g.applyQuaternion(q);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return g;
  }

  // Guardrail along the right edge: posts + a continuous beam, with one bent
  // gap (an old impact). Rusted painted metal.
  function buildGuardrail(): void {
    const railMat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.5 });
    applyPBR(railMat, makeMetalPainted('#6b5b4a', 7));
    patchWorldMaterial(railMat, { ashAmount: 1.2 });
    const geos: THREE.BufferGeometry[] = [];
    const gap0 = -60, gap1 = -74; // missing/bent section
    let beamStart = Z_START - 4;
    for (let z = Z_START - 4; z > Z_END + 6; z -= 4) {
      if (z < gap0 && z > gap1) continue;
      geos.push(new THREE.CylinderGeometry(0.045, 0.05, 0.72, 5).translate(RAIL_X, 0.36, z));
    }
    // Beam in two runs around the gap.
    const beamGeo = (z0: number, z1: number): THREE.BufferGeometry =>
      new THREE.BoxGeometry(0.1, 0.18, Math.abs(z1 - z0)).translate(RAIL_X, 0.55, (z0 + z1) / 2);
    geos.push(beamGeo(beamStart, gap0 + 1));
    geos.push(beamGeo(gap1 - 1, Z_END + 6));
    // A bent dangling beam piece in the gap.
    const bent = new THREE.BoxGeometry(0.1, 0.18, 12);
    bent.rotateX(0.5);
    bent.translate(RAIL_X + 0.3, 0.3, (gap0 + gap1) / 2);
    geos.push(bent);
    mergeInto(geos, railMat);
  }

  // A few dead trees out in the field.
  function makeDeadTree(x: number, z: number, seed: number): void {
    const treeMat = new THREE.MeshStandardMaterial({ color: '#2c2a26', roughness: 1 });
    patchWorldMaterial(treeMat, { ashAmount: 0.7 });
    const r = mulberry32(seed);
    const geos: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.08, 0.16, 3.4, 7).translate(0, 1.7, 0)];
    const n = 5 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const bl = 0.6 + r() * 0.9;
      const b = new THREE.CylinderGeometry(0.025, 0.05, bl, 5);
      b.translate(0, bl / 2, 0);
      b.rotateZ((r() * 2 - 1) * 1.3);
      b.rotateX((r() * 2 - 1) * 1.3);
      b.translate(0, 1.8 + r() * 1.4, 0);
      geos.push(b);
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    extraGeos.push(merged);
    extraMats.push(treeMat);
    const tree = new THREE.Mesh(merged, treeMat);
    tree.position.set(x, 0, z);
    tree.castShadow = true;
    group.add(tree);
    colliders.addBox(x, z, 0.25, 0.25);
  }

  buildPowerLine();
  buildGuardrail();
  makeDeadTree(-16, -34, 201);
  makeDeadTree(13, -88, 202);
  makeDeadTree(-22, -150, 203);
  makeDeadTree(18, -205, 204);

  // -- abandoned cars (one jackknifed across the lanes, the wreck a hot zone)
  const carPlacements: CarPlacement[] = [
    { x: 2.4, z: 30, yaw: Math.PI + 0.05, variant: 0 },
    { x: -2.6, z: 4, yaw: 0.04, variant: 1 },
    { x: 2.7, z: -28, yaw: Math.PI - 0.06, variant: 2 },
    { x: 0.2, z: -64, yaw: Math.PI / 2 + 0.3, variant: 1 }, // jackknifed
    { x: 2.6, z: -118, yaw: Math.PI + 0.5, variant: 2 }, // burned wreck (hot)
    { x: -2.8, z: -176, yaw: 0.02, variant: 0 },
    { x: 2.5, z: -214, yaw: Math.PI + 0.03, variant: 1 },
  ];
  group.add(buildAbandonedCars(carPlacements, 7));
  for (const p of carPlacements) colliders.addBox(p.x, p.z, 2.15, 0.9, p.yaw);

  // -- rubble + the road sign --------------------------------------------
  const rubble = [
    { x: -4.6, z: -46, radius: 1.3, height: 0.45 },
    { x: 4.4, z: -132, radius: 1.1, height: 0.4 },
  ];
  group.add(buildRubblePiles(rubble, 5));
  for (const p of rubble) colliders.addBox(p.x, p.z, p.radius * 0.8, p.radius * 0.8);

  const sign = buildPaintedSign(['ROSKILDE', '24 KM']);
  sign.position.set(5.4, 0, 38);
  sign.rotation.y = -0.5;
  sign.rotation.z = 0.07; // settled / leaning on its post after the fall
  group.add(sign);
  colliders.addBox(5.4, 38, 1.15, 0.18, -0.5);

  // Distant ruined skyline ring — the world goes on, fading into ash.
  group.add(buildSkylineCards(440));

  // -- collision corridor + caps -----------------------------------------
  colliders.addBox(CORRIDOR + 0.2, ROAD_MID, 0.2, ROAD_LEN / 2); // right wall
  colliders.addBox(-CORRIDOR - 0.2, ROAD_MID, 0.2, ROAD_LEN / 2); // left wall
  colliders.addBox(0, Z_START + 0.5, CORRIDOR + 1, 0.4); // behind (city)
  colliders.addBox(0, Z_END - 0.5, CORRIDOR + 1, 0.4); // ahead (Act II seam)

  // -- sky / sun / ash / god rays ----------------------------------------
  const sky = new SkySystem();
  const sunDir0 = getSunDirection(cfg.sun);
  sky.applyConfig(cfg.sky, sunDir0);
  group.add(sky.mesh);

  const sunRig = new SunRig(qualityManager.current.shadowMapSize);
  sunRig.applyConfig(cfg);
  group.add(sunRig.group);

  const ash = new AshParticles({ count: Math.floor(cfg.ash.count * qualityManager.current.particleMultiplier) });
  ash.setWind(cfg.ash.wind[0], cfg.ash.wind[1], cfg.ash.wind[2]);
  group.add(ash.points);

  const godRaysSource = new THREE.Mesh(
    new THREE.CircleGeometry(30, 32),
    new THREE.MeshBasicMaterial({ color: cfg.sky.sunDiscColor, transparent: true, opacity: 0.85, fog: false, depthWrite: false }),
  );
  godRaysSource.name = 'god-rays-source';
  godRaysSource.renderOrder = -999;
  godRaysSource.frustumCulled = false;
  group.add(godRaysSource);

  // -- actors -------------------------------------------------------------
  const ellen = new HumanoidActor({ height: 1.72, coatColor: '#4d5052', hoodColor: '#3f4244', scarfColor: '#5a4f42', seed: 1 });
  group.add(ellen.group);
  const player = new PlayerController(ellen, engine.camera, input, colliders);

  const jonasActor = new HumanoidActor({ height: 1.78, build: 0.25, coatColor: '#565349', hoodColor: '#4a473f', scarfColor: '#3f4347', seed: 2, pack: true });
  group.add(jonasActor.group);
  const jonas = new Follower(jonasActor, { offsetBack: 2.1, offsetSide: -1.4, maxSpeed: 3.0, radius: 0.3 });

  const birkActor = new DogActor({ seed: 3 });
  group.add(birkActor.group);
  const birk = new Follower(birkActor, { offsetBack: 1.0, offsetSide: 1.1, maxSpeed: 4.0, radius: 0.25 });
  const others: THREE.Vector3[] = [jonas.position, birk.position];

  // -- M3 systems for this scene -----------------------------------------
  const radiation = new RadiationField(RAD_SOURCES);
  const meterEnv: MeterEnv = { indoors: false, nearHeat: false, radiation: 0, radioOn: false };
  const hudInfo = { geigerRate: 0 };
  const beats = new RoadBeats({
    state,
    dialogue,
    radio,
    autosave: () => save.save('roadA', { x: player.position.x, z: player.position.z, yaw: player.heading }),
  });

  function applyConfig(): void {
    worldUniforms.uFogColor.value.set(cfg.fog.color);
    worldUniforms.uFogDensity.value = cfg.fog.density;
    worldUniforms.uHeightFogDensity.value = cfg.fog.heightDensity;
    worldUniforms.uHeightFogFalloff.value = cfg.fog.heightFalloff;
    worldUniforms.uHeightFogOffset.value = cfg.fog.heightOffset;
    worldUniforms.uFogNoiseAmount.value = cfg.fog.noiseAmount;
    worldUniforms.uAshLevel.value = cfg.ash.level;
    engine.scene.background = null;
  }

  return {
    id: 'roadA',
    player,
    godRaysSource,

    load(): void {
      applyConfig();
      engine.scene.add(group);
      engine.scene.environment = sky.buildEnvironment(engine.renderer);
      engine.scene.environmentIntensity = 0.85;
      post.setExposure(cfg.exposure, true);
      player.spawn(0.5, 44, Math.PI); // facing −Z: onward, toward the low sun
      jonas.warpToSlot(player.position, player.heading);
      birk.warpToSlot(player.position, player.heading);
      beats.reset();
      radio.setSignals(buildRoadSignals(player));
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
      godRaysSource.position.copy(engine.camera.position).addScaledVector(sunRig.sunDir, -GOD_RAYS_DISTANCE);
      godRaysSource.lookAt(engine.camera.position);

      const px = player.position.x;
      const pz = player.position.z;

      if (state.radio.on) {
        if (input.pressed('ArrowLeft')) radio.tune(-1, dt);
        if (input.pressed('ArrowRight')) radio.tune(1, dt);
      }
      radio.update(dt, px, pz);

      const rad = radiation.sampleAt(px, pz);
      geiger.update(dt, rad);

      meterEnv.indoors = false;
      meterEnv.nearHeat = false; // no heat on the open road — VARME bleeds
      meterEnv.radiation = rad;
      meterEnv.radioOn = state.radio.on;
      meters.update(dt, meterEnv);

      dialogue.update(dt);
      beats.update(dt, px, pz);

      hudInfo.geigerRate = geiger.displayRate;
      hud.update(dt, hudInfo);
      radioOverlay.update(dt, radio.signalLevel);
      journal.setPlayerPos(px, pz, player.heading);
      journal.update(dt);
    },

    dispose(): void {
      engine.scene.remove(group);
      group.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh || (obj as THREE.Points).isPoints) {
          const mesh = obj as THREE.Mesh;
          mesh.geometry.dispose();
          const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) for (const m of mat) m.dispose();
          else mat?.dispose();
        }
      });
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
      post.setExposure(cfg.exposure, true);
    },
  };
}
