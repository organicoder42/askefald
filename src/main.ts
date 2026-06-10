import * as THREE from 'three';
import { Engine } from './core/engine';
import { Input } from './core/input';
import { qualityManager } from './core/quality';
import { FreeCam } from './debug/freeCam';
import { PerfHud } from './debug/perfHud';
import { ACT_CONFIGS } from './graphics/palette';
import { patchWorldMaterial, worldUniforms } from './graphics/worldMaterial';

// ---- M0 bootstrap: empty fogged world, free-cam, perf HUD ----

const container = document.getElementById('app')!;
const engine = new Engine(container);
const input = new Input(engine.canvas);
const hud = new PerfHud(engine.renderer);
const freeCam = new FreeCam(engine.camera, input);

const act = ACT_CONFIGS.act1;
engine.renderer.toneMappingExposure = act.exposure;
engine.resolutionScale = qualityManager.current.resolutionScale;
engine.applySize();

worldUniforms.uFogColor.value.set(act.fog.color);
worldUniforms.uFogDensity.value = act.fog.density;
engine.scene.background = new THREE.Color(act.fog.color);

// Ground
const groundMat = new THREE.MeshStandardMaterial({ color: '#4c4f52', roughness: 0.95 });
patchWorldMaterial(groundMat, { ashAmount: 1.2 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800, 1, 1), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
engine.scene.add(ground);

// A march of reference boxes to read fog depth
const boxMat = new THREE.MeshStandardMaterial({ color: '#5a5d60', roughness: 0.85 });
patchWorldMaterial(boxMat);
const boxGeo = new THREE.BoxGeometry(2, 4, 2);
for (let i = 0; i < 12; i++) {
  const box = new THREE.Mesh(boxGeo, boxMat);
  box.position.set(i % 2 === 0 ? -6 : 6, 2, -12 - i * 16);
  box.castShadow = true;
  box.receiveShadow = true;
  engine.scene.add(box);
}

// Lights
const hemi = new THREE.HemisphereLight(act.hemi.skyColor, act.hemi.groundColor, act.hemi.intensity);
engine.scene.add(hemi);
const sun = new THREE.DirectionalLight(act.sun.color, act.sun.intensity);
sun.position.set(10, 18, 30);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(2048);
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -40;
engine.scene.add(sun);

engine.camera.position.set(0, 1.7, 8);

input.onKey('F3', () => hud.toggle());
hud.toggle(); // visible during development

engine.onUpdate((dt, elapsed) => {
  worldUniforms.uTime.value = elapsed;
  freeCam.update(dt);
  hud.update(dt);
  input.endFrame();
});

engine.start();
document.getElementById('boot')?.remove();
