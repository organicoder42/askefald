import * as THREE from 'three';
import GUI from 'lil-gui';
import type { Engine } from '../core/engine';
import type { LookdevScene } from '../scenes/lookdev';
import type { PostStack } from '../graphics/post';
import { ACT_CONFIGS, getSunDirection } from '../graphics/palette';
import type { ActLookConfig } from '../graphics/palette';
import { worldUniforms } from '../graphics/worldMaterial';

/**
 * lil-gui look-dev panel (§10.4): live sliders for fog (color/density/
 * height/noise), sun (elevation/azimuth/intensity), ash (level, particle
 * density, storm), exposure — tune by eye, then bake values back into
 * ACT_CONFIGS. Toggled with KeyG. Debug only.
 *
 * Returns a teardown function.
 */

const _sunDir = new THREE.Vector3();

export function setupLookdevGui(
  engine: Engine,
  scene: LookdevScene,
  post: PostStack | null,
): () => void {
  const gui = new GUI({ title: 'ASKEFALD look-dev' });
  gui.hide();

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'KeyG') gui.show(gui._hidden);
  };
  window.addEventListener('keydown', onKeyDown);

  // ---- Fog: writes straight into the shared world uniforms ----
  const fogFolder = gui.addFolder('Fog');
  const fogParams = { color: `#${worldUniforms.uFogColor.value.getHexString()}` };
  fogFolder
    .addColor(fogParams, 'color')
    .name('uFogColor')
    .onChange((v: string) => worldUniforms.uFogColor.value.set(v));
  fogFolder.add(worldUniforms.uFogDensity, 'value', 0, 0.02).name('uFogDensity');
  fogFolder.add(worldUniforms.uHeightFogDensity, 'value', 0, 1).name('uHeightFogDensity');
  fogFolder.add(worldUniforms.uHeightFogFalloff, 'value', 0, 0.4).name('uHeightFogFalloff');
  fogFolder.add(worldUniforms.uFogNoiseAmount, 'value', 0, 1).name('uFogNoiseAmount');

  // ---- Sun: edits a LOCAL copy of act1 (never mutates ACT_CONFIGS), then
  // re-applies both the light rig and the sky so the disc stays aligned. ----
  const sunCfg: ActLookConfig = { ...ACT_CONFIGS.act1, sun: { ...ACT_CONFIGS.act1.sun } };
  const applySun = (): void => {
    scene.sunRig.applyConfig(sunCfg);
    scene.sky.applyConfig(sunCfg.sky, getSunDirection(sunCfg.sun, _sunDir));
  };
  const sunFolder = gui.addFolder('Sun');
  sunFolder.add(sunCfg.sun, 'elevationDeg', 2, 25).onChange(applySun);
  sunFolder.add(sunCfg.sun, 'azimuthDeg', -90, 90).onChange(applySun);
  sunFolder.add(sunCfg.sun, 'intensity', 0, 6).onChange(applySun);
  const actions = {
    rebakeIbl: (): void => {
      const old = engine.scene.environment;
      engine.scene.environment = scene.sky.buildEnvironment(engine.renderer);
      if (old) old.dispose();
    },
  };
  sunFolder.add(actions, 'rebakeIbl').name('Rebake IBL');

  // ---- Ash ----
  const ashFolder = gui.addFolder('Ash');
  ashFolder.add(worldUniforms.uAshLevel, 'value', 0, 1.2).name('uAshLevel');
  const ashParams = { density: 1, storm: 0 };
  ashFolder
    .add(ashParams, 'density', 0, 1.5)
    .name('particle density')
    .onChange((v: number) => scene.ash.setDensity(v));
  ashFolder.add(ashParams, 'storm', 0, 1).onChange((v: number) => scene.ash.setStorm(v));

  // ---- Post ----
  if (post) {
    const postFolder = gui.addFolder('Post');
    const postParams = { exposure: ACT_CONFIGS.act1.exposure };
    postFolder
      .add(postParams, 'exposure', 0.3, 2)
      .onChange((v: number) => post.setExposure(v, true));
  }

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    gui.destroy();
  };
}
