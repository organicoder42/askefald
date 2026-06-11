import { Engine } from './core/engine';
import { Input } from './core/input';
import { qualityManager } from './core/quality';
import { FreeCam } from './debug/freeCam';
import { PerfHud } from './debug/perfHud';
import { setupLookdevGui } from './debug/gui';
import { createPostStack } from './graphics/post';
import { ACT_CONFIGS } from './graphics/palette';
import { buildLookdevScene } from './scenes/lookdev';

// ---- M1: rendering core + look-dev street ----

const container = document.getElementById('app')!;
const engine = new Engine(container);
const input = new Input(engine.canvas);
const hud = new PerfHud(engine);

engine.resolutionScale = qualityManager.current.resolutionScale;
engine.applySize();

const scene = buildLookdevScene(engine);

const post = createPostStack(engine, {
  godRaysSource: scene.godRaysSource,
  quality: qualityManager.current,
  act: 'act1',
});
post.setExposure(ACT_CONFIGS.act1.exposure, true);
engine.setRenderFn((dt) => post.render(dt));
engine.onResize((w, h) => post.setSize(w, h));

qualityManager.onChange((q) => {
  engine.resolutionScale = q.resolutionScale;
  engine.applySize();
  post.applyQuality(q);
  scene.sunRig.setShadowMapSize(q.shadowMapSize);
});

// Camera spawn: mid-street at eye height, looking down-street toward the askesol.
// Orientation must be set BEFORE FreeCam construction (it adopts the quaternion).
// Headless verification hook: ?cam=x,y,z,tx,ty,tz overrides the pose.
engine.camera.position.set(1.2, 1.7, 28);
engine.camera.lookAt(0.5, 3.5, -80);
const camParam = /[?&]cam=([^&]+)/.exec(location.search);
if (camParam) {
  const v = camParam[1].split(',').map(Number);
  if (v.length === 6 && v.every((n) => Number.isFinite(n))) {
    engine.camera.position.set(v[0], v[1], v[2]);
    engine.camera.lookAt(v[3], v[4], v[5]);
  }
}
const freeCam = new FreeCam(engine.camera, input);

input.onKey('F3', () => hud.toggle());
hud.toggle(); // on by default during look-dev

setupLookdevGui(engine, scene, post);

engine.onUpdate((dt, elapsed) => {
  freeCam.update(dt);
  scene.update(dt, elapsed, engine.camera);
  hud.update(dt);
  input.endFrame();
});

engine.start();
document.getElementById('boot')?.remove();

// Headless verification hook: ?noao disables ambient occlusion for A/B shots.
if (location.search.includes('noao')) {
  post.applyQuality({ ...qualityManager.current, aoEnabled: false });
}

// Headless verification hook: ?stats logs render budgets to the console.
if (location.search.includes('stats')) {
  setInterval(() => {
    const info = engine.renderer.info;
    console.log(
      `STATS calls=${engine.frameStats.calls} tris=${engine.frameStats.triangles} ` +
        `geom=${info.memory.geometries} tex=${info.memory.textures} progs=${info.programs?.length ?? 0}`,
    );
  }, 2000);
}
