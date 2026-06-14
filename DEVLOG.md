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

## M2 — Player & world kit (in progress)

- Collision is deliberately 2D (`ColliderWorld`): a moving circle against
  yaw-rotated boxes in XZ plus a sampled ground-height function (road 0,
  sidewalks/interiors +0.13, smooth curb ramps). The game has no jumping,
  no stacking, no ragdolls — full 3D physics buys nothing here (§10.1).
- Yaw convention pinned project-wide after an M2 false start: facing =
  (sin yaw, 0, cos yaw); actor groups face local +Z. Player spawn heading π
  = down-street (−Z).
- Tier-B characters are SEGMENTED joint hierarchies (Groups as bones with
  meshes), not SkinnedMesh: with everyone in hooded coats the joints hide
  under cloth silhouettes, the pose math stays trivial and allocation-free,
  and Tier-A glTF skinning can replace the rig without touching callers
  (same setLocomotion/update/lookAt contract). Foot-slide rule: gait phase
  advances by distance travelled, never time.
- Scene manager wipes engine.scene between scenes and the god-rays source
  is swapped via post.setGodRaysSource (GodRaysEffect captures its mesh at
  construction, so the pass is rebuilt in place).
- Exposure adaptation beat: candle flat interior targets exposure 1.35 vs
  act exterior 0.92, trigger zone at the threshold, existing ~2 s lerp does
  the "eyes adjusting" (§6.8).
- Headless walk-testing: `?walk` debug-holds KeyW so virtual-time
  screenshots capture mid-stride poses with followers trailing; `?spawn=`
  repositions the player (exposure-trigger verification).
- 7-angle code review (line-scan, removed-behavior, cross-file, reuse,
  simplification, efficiency, altitude/lifecycle) caught and fixed:
  - collision.ts world→local rotation was the transpose of the correct
    inverse — every yawed collider (angled cars, the sign, flat walls)
    was mirrored vs its visual. Convention now documented in the file.
  - Right-side lamp colliders registered at negated z (visible posts
    walk-through, invisible posts elsewhere).
  - post.setGodRaysSource rebuilt the EffectPass via dispose(), which
    destroys SHARED child effects (SMAA/bloom render targets). Rebuilt
    around ONE persistent GodRaysEffect with a settable lightSource and
    an internal far-away proxy when no scene provides a sun.
  - Candle flicker lerp weights were swapped (9 Hz popping).
  - Quality switches now reach scenes (GameScene.applyQuality → shadow
    map size + ash density); FreeCam re-syncs from the camera on enable;
    camera boom probes use a 0.6 m span so the gennemgang arch doesn't
    yank the camera in.
- Deferred to M3 housekeeping: consolidate mulberry32 (6 copies),
  dampAngle (4), applyPBR (3) into shared modules; a TriggerZone
  abstraction for interior exposure beats; generalize per-scene
  god-rays/player glue onto GameScene. Draw calls 304 on the street —
  segmented actors cost ~17 draws each; Tier-A skinned meshes (1 draw)
  are the planned recovery.
- Deferred: depth-buffer soft particles (reading the depth texture of the
  buffer being rendered into is a feedback hazard with the pmndrs composer —
  needs a depth-copy pass; quality flag `softParticles` reserved). Radial
  alpha falloff + fog fade carries the look meanwhile.
- Deferred: ash footprint trail map (M2 — needs the player controller).
- Known tuning debt: shadow normalBias vs. grazing 8° sun on flat ash;
  exposure/LUT balance to be tuned by eye via the KeyG lil-gui panel, then
  baked back into ACT_CONFIGS.

## M3 — Systems (2026-06-14)

- Housekeeping first (commit fab9a75): `src/core/math.ts` collapses the
  6× mulberry32 / 4× dampAngle / clamp / smoothstep copies (+lerp, damp);
  `applyPBR` now lives beside PBRSet in textures.ts. `src/core/triggers.ts`
  (TriggerZone/TriggerSet, enter/exit hysteresis) replaces act1's hardcoded
  flat-exposure beat. GameScene grew optional `player`/`godRaysSource` and
  SceneManager an `onSwitch` hook, so main.ts wires god-rays + free-cam +
  HUD visibility generically — act1 registers its factory with no wrapper.
- Layered the systems on three lynchpins authored inline before fan-out:
  `audio/audioEngine.ts` (lazy AudioContext on first gesture; master→
  sfx/radio/geiger buses; deterministic cached noise; SILENT+error-free
  while ctx null — headless never gets a gesture), `systems/gameState.ts`
  (the single mutable save surface: meters/radio/flags/journal +
  serialize/applySave), `ui/uiShell.ts` (one fixed pointer-events:none DOM
  overlay; rationed UI chroma — chalk text, amber ONLY for warnings + the
  radio needle; Danish diegetic text).
- Modules built against frozen skeleton contracts. A 6-way build+verify
  workflow finished meters / geiger(+audio) / dialogue(+subtitles) / hud
  before a session limit killed it; the radio trio (radio + synth +
  overlay), save and journal were finished inline (CLAUDE.md straggler
  rule). Zero `not implemented` left; tsc clean throughout.
- Radio (§4.4) is the signature mechanic: continuous 88–108 MHz dial, lock
  = squared proximity inside each signal's bandwidth, audible = lock ×
  positional strength — so tuning AND walking toward a transmitter both
  matter. RadioAudio is pure WebAudio synthesis (looped-noise static bed,
  heterodyne whistle tracking dial distance, gated-tone morse from a
  precomputed message timeline, wandering-formant "distant voice"), one
  graph built once, per-frame = param automation only.
- Geiger: linear-falloff RadiationField (max, no stacking) → Poisson click
  scheduler (rate 0.18 + 28·intensity², exponential intervals from a
  seeded stream) → one-shot filtered-noise ticks; HUD shows a damped
  clicks/s as a Danish "mSv/t" dose. FILTRE drains with field intensity.
- Story: `story/act1Beats.ts` drives Act I beats 1–4 (wake in the flat →
  intro → first radio lock reads ROSKILDE in morse → onto the ash street →
  first hot rubble zone → the painted sign), one-shot via GameState flags
  so a restored save never replays; unlocks journal entries + autosaves.
- Verified headless (1600×900, virtual-time): meter bars + Danish labels,
  Geiger dose scaling 0,0 → 1,1 mSv/t with distance to rubble, radio band
  with amber needle at 96,4 and signal bars, cinematic Danish subtitle,
  hand-drawn journal map (ØSTERGADE, the flat, courtyard, rubble ✕) with
  the player marker correctly placed. Budgets: 202 draw calls / 120 k tris
  (UI is DOM — no GPU cost). No console errors with audio armed.
- Bug found+fixed in verify: the journal player marker is
  `position:absolute` with no top/left, so it anchored to its in-flow
  position AFTER the 560 px canvas (bottom) and translate offset from
  there — pinned to top:0/left:0 so the world→canvas projection reads true.
- Headless UI hooks added to main.ts: `?radio`, `?freq=NN.N`, `?journal`,
  `?sub` (the new UI only appears on input a headless run can't deliver).
- Deferred: radio battery pickups + meter recovery items (M4 content);
  dialogue camera-takeover / DoF (M3 is walk-and-talk only); per-act radio
  signal sets beyond Act I; precise mSv calibration (reads plausibly, tune
  by eye later). Save is single-slot localStorage v1 with strict validate-
  or-null; multi-slot UI is post-M3.
