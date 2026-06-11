import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  GodRaysEffect,
  LUT3DEffect,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { Engine } from '../core/engine';
import type { QualitySettings } from '../core/quality';
import { ACT_CONFIGS, type ActId } from './palette';
import { generateActLUT } from './luts';

/**
 * Post-processing stack (§6.8), pmndrs `postprocessing` + `n8ao`.
 * Chain: RenderPass → N8AO → EffectPass(SMAA, GodRays?, Bloom, CA) →
 * EffectPass(DoF, disabled unless dialogue) →
 * EffectPass(AgX tone mapping, per-act LUT, Vignette, film grain).
 *
 * Tone-mapping architecture: the scene renders into HalfFloat buffers where
 * three skips tone mapping entirely, so the renderer is switched to
 * NoToneMapping and AgX is applied explicitly by ToneMappingEffect in the
 * final pass. Its AGX mode resolves to three's AgXToneMapping(), which
 * multiplies by the `toneMappingExposure` uniform — bound from
 * renderer.toneMappingExposure for every program that declares it — so
 * exposure adaptation (§6.8 "eyes adjusting") drives the renderer value.
 */
export interface PostStackOptions {
  /** Emissive disc mesh aligned with the sun for GodRaysEffect; null = no god rays. */
  godRaysSource?: THREE.Mesh | null;
  quality: QualitySettings;
  act: ActId;
}

export interface PostStack {
  render(dt: number): void;
  setSize(width: number, height: number): void;
  setAct(act: ActId): void;
  /** Target exposure; lerped over ~2 s unless immediate. */
  setExposure(target: number, immediate?: boolean): void;
  setDofEnabled(enabled: boolean): void;
  applyQuality(q: QualitySettings): void;
  dispose(): void;
}

export function createPostStack(engine: Engine, opts: PostStackOptions): PostStack {
  const { renderer, scene, camera } = engine;

  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = ACT_CONFIGS[opts.act].exposure;

  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    stencilBuffer: false,
  });

  composer.addPass(new RenderPass(scene, camera));

  const n8ao = new N8AOPostPass(scene, camera, engine.size.width, engine.size.height);
  n8ao.configuration.aoRadius = 2.0;
  n8ao.configuration.distanceFalloff = 1.0;
  n8ao.configuration.intensity = 2.0;
  n8ao.configuration.halfRes = opts.quality.aoHalfRes;
  // The composer owns color space end to end; n8ao's own sRGB conversion
  // must stay off or it corrupts the HDR chain (per n8ao README).
  n8ao.configuration.gammaCorrection = false;
  n8ao.enabled = opts.quality.aoEnabled;
  composer.addPass(n8ao);

  const smaa = new SMAAEffect();
  // Restraint (§6.8): the askesol must be the single brightest SHAPE, not
  // the centre of a frame-wide blowout — high threshold, low intensity.
  const bloom = new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: 0.95,
    intensity: 0.22,
  });
  const chromaticAberration = new ChromaticAberrationEffect({
    offset: new THREE.Vector2(0.0006, 0.0006),
    radialModulation: true,
    modulationOffset: 0.4,
  });

  let godRays: GodRaysEffect | null = null;
  if (opts.godRaysSource) {
    godRays = new GodRaysEffect(camera, opts.godRaysSource, {
      density: 0.96,
      decay: 0.92,
      weight: 0.13,
      exposure: 0.17,
      samples: 48,
      clampMax: 0.6,
      blur: true,
    });
  }

  // SMAA carries the CONVOLUTION attribute, as does ChromaticAberration —
  // pmndrs allows only one convolution effect per EffectPass, so CA lives
  // in the grade pass instead.
  const mainEffects = godRays
    ? new EffectPass(camera, smaa, godRays, bloom)
    : new EffectPass(camera, smaa, bloom);
  composer.addPass(mainEffects);

  const dof = new DepthOfFieldEffect(camera, {
    focusDistance: 0.012,
    focalLength: 0.05,
    bokehScale: 3.0,
  });
  const dofPass = new EffectPass(camera, dof);
  dofPass.enabled = false;
  composer.addPass(dofPass);

  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  let lutEffect = new LUT3DEffect(generateActLUT(ACT_CONFIGS[opts.act].grade));
  const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.45 });
  const grain = new NoiseEffect({ blendFunction: BlendFunction.SCREEN, premultiply: true });
  grain.blendMode.opacity.value = 0.04;
  let gradePass = new EffectPass(camera, chromaticAberration, toneMapping, lutEffect, vignette, grain);
  composer.addPass(gradePass);

  // Exposure adaptation state (~2 s exponential time constant).
  let exposureTarget = renderer.toneMappingExposure;
  let dofAllowed = opts.quality.dofAllowed;

  const stack: PostStack = {
    render(dt: number): void {
      const current = renderer.toneMappingExposure;
      if (current !== exposureTarget) {
        const k = 1 - Math.exp(-dt / 0.7); // ≈ settles within ~2 s
        const next = current + (exposureTarget - current) * k;
        renderer.toneMappingExposure =
          Math.abs(next - exposureTarget) < 1e-4 ? exposureTarget : next;
      }
      composer.render(dt);
    },

    setSize(width: number, height: number): void {
      composer.setSize(width, height);
    },

    setAct(act: ActId): void {
      // Swapping the LUT inside an existing EffectPass invalidates its
      // compiled shader; rebuilding the pass is the supported path.
      const cfg = ACT_CONFIGS[act];
      const newLut = new LUT3DEffect(generateActLUT(cfg.grade));
      const newPass = new EffectPass(camera, chromaticAberration, toneMapping, newLut, vignette, grain);
      composer.removePass(gradePass);
      gradePass.dispose();
      lutEffect = newLut;
      gradePass = newPass;
      composer.addPass(gradePass);
      stack.setExposure(cfg.exposure);
    },

    setExposure(target: number, immediate = false): void {
      exposureTarget = target;
      if (immediate) renderer.toneMappingExposure = target;
    },

    setDofEnabled(enabled: boolean): void {
      dofPass.enabled = enabled && dofAllowed;
    },

    applyQuality(q: QualitySettings): void {
      n8ao.enabled = q.aoEnabled;
      n8ao.configuration.halfRes = q.aoHalfRes;
      if (godRays) godRays.blendMode.blendFunction = q.godRays
        ? BlendFunction.SCREEN
        : BlendFunction.SKIP;
      dofAllowed = q.dofAllowed;
      if (!dofAllowed) dofPass.enabled = false;
    },

    dispose(): void {
      composer.dispose();
    },
  };

  return stack;
}
