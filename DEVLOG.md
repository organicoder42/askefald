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
- Deferred: depth-buffer soft particles (reading the depth texture of the
  buffer being rendered into is a feedback hazard with the pmndrs composer —
  needs a depth-copy pass; quality flag `softParticles` reserved). Radial
  alpha falloff + fog fade carries the look meanwhile.
- Deferred: ash footprint trail map (M2 — needs the player controller).
- Known tuning debt: shadow normalBias vs. grazing 8° sun on flat ash;
  exposure/LUT balance to be tuned by eye via the KeyG lil-gui panel, then
  baked back into ACT_CONFIGS.
