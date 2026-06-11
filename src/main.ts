import { Engine } from './core/engine';
import { Input } from './core/input';
import { qualityManager } from './core/quality';
import { SceneManager, type GameScene } from './core/sceneManager';
import { FreeCam } from './debug/freeCam';
import { PerfHud } from './debug/perfHud';
import { setupLookdevGui } from './debug/gui';
import { createPostStack } from './graphics/post';
import { ACT_CONFIGS } from './graphics/palette';
import { buildLookdevScene } from './scenes/lookdev';
import { createAct1City, type Act1CityScene } from './scenes/act1_city';

// ---- M2: scene manager — act1 city (playable) + lookdev (tuning) ----

const container = document.getElementById('app')!;
const engine = new Engine(container);
const input = new Input(engine.canvas);
const hud = new PerfHud(engine);
const freeCam = new FreeCam(engine.camera, input);
freeCam.enabled = false;

engine.resolutionScale = qualityManager.current.resolutionScale;
engine.applySize();

const post = createPostStack(engine, {
  godRaysSource: null,
  quality: qualityManager.current,
  act: 'act1',
});
post.setExposure(ACT_CONFIGS.act1.exposure, true);
engine.setRenderFn((dt) => post.render(dt));
engine.onResize((w, h) => post.setSize(w, h));

const sceneManager = new SceneManager(engine);
let act1: Act1CityScene | null = null;
// Accessor defeats top-level flow narrowing (assignments happen in closures).
const getAct1 = (): Act1CityScene | null => act1;

sceneManager.register('lookdev', (): GameScene => {
  let scene: ReturnType<typeof buildLookdevScene> | null = null;
  let guiTeardown: (() => void) | null = null;
  return {
    id: 'lookdev',
    load() {
      scene = buildLookdevScene(engine);
      post.setGodRaysSource(scene.godRaysSource);
      post.setExposure(ACT_CONFIGS.act1.exposure, true);
      guiTeardown = setupLookdevGui(engine, scene, post);
      engine.camera.position.set(1.2, 1.7, 28);
      engine.camera.lookAt(0.5, 3.5, -80);
      freeCam.syncFromCamera(); // keep the authored framing
      freeCam.enabled = true;
      act1 = null;
    },
    update(dt, elapsed) {
      scene?.update(dt, elapsed, engine.camera);
    },
    applyQuality(q) {
      scene?.sunRig.setShadowMapSize(q.shadowMapSize);
      scene?.ash.setDensity(q.particleMultiplier);
    },
    dispose() {
      guiTeardown?.();
      post.setGodRaysSource(null);
      scene?.dispose();
      scene = null;
    },
  };
});

sceneManager.register('act1', (): GameScene => {
  const scene = createAct1City(engine, input, post);
  return {
    id: 'act1',
    load() {
      scene.load();
      post.setGodRaysSource(scene.godRaysSource);
      act1 = scene;
      freeCam.enabled = false;
    },
    update(dt, elapsed) {
      scene.update(dt, elapsed);
    },
    applyQuality(q) {
      scene.applyQuality?.(q);
    },
    dispose() {
      post.setGodRaysSource(null);
      scene.dispose();
      act1 = null;
    },
  };
});

qualityManager.onChange((q) => {
  engine.resolutionScale = q.resolutionScale;
  engine.applySize();
  post.applyQuality(q);
  sceneManager.applyQuality(q);
});

// Debug controls: F3 perf HUD, F8 free-cam toggle, 1/2 scene jump.
input.onKey('F3', () => hud.toggle());
input.onKey('F8', () => {
  freeCam.enabled = !freeCam.enabled;
  if (freeCam.enabled) freeCam.syncFromCamera(); // continue from the current view
  if (act1) act1.player.enabled = !freeCam.enabled;
});
input.onKey('Digit1', () => sceneManager.switchTo('lookdev'));
input.onKey('Digit2', () => sceneManager.switchTo('act1'));
hud.toggle(); // on by default during development

engine.onUpdate((dt, elapsed) => {
  if (freeCam.enabled) freeCam.update(dt);
  sceneManager.update(dt, elapsed);
  hud.update(dt);
  input.endFrame();
});

// Headless verification hooks: ?scene=lookdev, ?walk (auto-walk forward),
// ?cam=x,y,z,tx,ty,tz (free-cam pose), ?noao, ?stats.
const search = location.search;
const sceneParam = /[?&]scene=(\w+)/.exec(search)?.[1];
sceneManager.switchTo(sceneParam === 'lookdev' ? 'lookdev' : 'act1');

if (search.includes('walk')) input.debugHold('KeyW');

// ?spawn=x,z,yaw repositions the player (e.g. inside the flat to verify the
// exposure-adaptation trigger headlessly).
const spawnParam = /[?&]spawn=([^&]+)/.exec(search);
if (spawnParam) {
  const v = spawnParam[1].split(',').map(Number);
  const a = getAct1();
  if (a && v.length === 3 && v.every((n) => Number.isFinite(n))) {
    a.player.spawn(v[0], v[1], v[2]);
  }
}

const camParam = /[?&]cam=([^&]+)/.exec(search);
if (camParam) {
  const v = camParam[1].split(',').map(Number);
  if (v.length === 6 && v.every((n) => Number.isFinite(n))) {
    freeCam.enabled = false; // static framing for screenshots
    const a = getAct1();
    if (a) a.player.enabled = false;
    engine.camera.position.set(v[0], v[1], v[2]);
    engine.camera.lookAt(v[3], v[4], v[5]);
  }
}

if (search.includes('noao')) {
  post.applyQuality({ ...qualityManager.current, aoEnabled: false });
}

if (search.includes('stats')) {
  setInterval(() => {
    const info = engine.renderer.info;
    console.log(
      `STATS calls=${engine.frameStats.calls} tris=${engine.frameStats.triangles} ` +
        `geom=${info.memory.geometries} tex=${info.memory.textures} progs=${info.programs?.length ?? 0}`,
    );
  }, 2000);
}

engine.start();
document.getElementById('boot')?.remove();
