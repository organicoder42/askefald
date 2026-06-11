# DEVLOG — ASKEFALD

## M0 — Bootstrap (2026-06-10)

- Vite + TS strict scaffold; three@0.184, postprocessing@6.39, n8ao@1.10.
- Engine: single RAF via renderer.setAnimationLoop, pluggable render fn (post
  stack takes over in M1), resolution-scale-aware resize.
- Decided early: **scene.fog stays null forever** — all fog comes from the
  shared `worldMaterial.ts` injection so distance fog + height fog + noise are
  one consistent system in linear HDR space, and custom shaders (ash
  particles) can reuse the exact same GLSL.
- Ash-settle shader injected at `roughnessmap_fragment` (after roughnessFactor
  resolves, before lighting) — blends albedo+roughness by world-normal Y with
  two-octave world-space noise for drift edges. Per-material `ashAmount` ×
  global `uAshLevel`.
- World position derived manually in the vertex shader (`modelMatrix *
  instanceMatrix * transformed`) instead of relying on three's `worldpos_vertex`
  (only compiled-in under specific defines). World normal recovered via the
  `(vec4(transformedNormal,0) * viewMatrix).xyz` transpose trick — works for
  instanced + skinned without extra uniforms.
- Verified: fogged test world at 13 draw calls; ash mottle reads on ground.
  (Headless-Chrome fps numbers are not representative — software GL.)

## M1 — Rendering core (in progress)

- Module build fanned out to 7 parallel agents against frozen TS contracts
  (skeleton files with full signatures + doc-comment contracts; specs in
  docs/m1-specs/).
- Integration findings (2026-06-11):
  - pmndrs `postprocessing` allows only ONE convolution-class effect per
    EffectPass; SMAA and ChromaticAberration both carry CONVOLUTION, so CA
    lives in the final grade pass (CA → AgX tone map → LUT → vignette →
    grain), SMAA + GodRays + Bloom in the first.
  - `n8ao` `configuration.gammaCorrection` MUST be false inside the
    composer chain — its default sRGB conversion mid-chain crushed the
    whole frame and masked lighting changes during tuning.
  - Look tuning truths: overcast Nordic noon is ambient-dominated — hemi
    1.5 / env 0.85 / sun 2.8 at 10° elevation reads right; near-white
    window frames register as "lit windows" at street distance; per-tile
    soot-wash gradients band at every floor (keep ≤0.08 alpha); candle
    emissive above ~1.3 desaturates to white under AgX (keep ~1.0, deep
    amber #b5701f).
  - three r184 deprecates PCFSoftShadowMap (falls back to PCF) — revisit
    shadow filtering (VSM?) during M7 polish.
  - One agent artifact: a literal NUL byte inside a template string made
    textures.ts read as binary to grep/file (tsc/vite were fine) —
    replaced with \\u0000.
  - Budgets at look-dev: 160 draw calls, 145k tris, 33 programs, 92
    textures. Headless-Chrome fps is software-GL and not meaningful;
    real-hardware 60 fps check pending a run on the host GPU.
- Three-lens visual critique round (cinematography / photo-realism /
  art-direction agents reading the screenshots) → applied fixes:
  - Askesolen now sits IN the street gap (elevation 6°, azimuth 2°) as a
    readable disc: bloom threshold 0.8→0.95 + intensity 0.22 so the disc is
    the brightest SHAPE, not the centre of a blowout; god-rays weight/clamp
    halved; sky haze term cut 0.12→0.05.
  - Ground reads as ash blanket, not wet asphalt: ground ashAmount 1.1→1.7,
    global uAshLevel 0.62→0.78, ash tint brightened to #a6a8a5 (the
    asphalt's repeating lane-dash streaks vanished under the blanket —
    deliberate tire-track decals deferred to M2+).
  - Candles survive AgX now: emissive #E8A23C at flicker 0.6±0.3 lands
    ≈rgb(215,150,70) on screen instead of clipping white; lit windows moved
    to mid-distance blocks so the eye-path runs candle → candle → sun.
  - Particles de-snowed: flake luminance 0.72→0.58, full fog dissolve +
    hard distance fade by 70 m, size variance 0.4–2.2 biased small.
  - Plaster blotch contrast cut ~60% (camo-patch read); wheels lifted off
    pure black.
- Verified `npm run build` (tsc strict + vite) — 331 kB gzip, no assets.
- Deferred: depth-buffer soft particles (reading the depth texture of the
  buffer being rendered into is a feedback hazard with the pmndrs composer —
  needs a depth-copy pass; quality flag `softParticles` reserved). Radial
  alpha falloff + fog fade carries the look meanwhile.
- Deferred: ash footprint trail map (M2 — needs the player controller).
- Known tuning debt: shadow normalBias vs. grazing 8° sun on flat ash;
  exposure/LUT balance to be tuned by eye via the KeyG lil-gui panel, then
  baked back into ACT_CONFIGS.
