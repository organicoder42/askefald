# ASKEFALD — project notes for Claude

Cinematic third-person narrative survival game in Three.js. Denmark after a
nuclear winter; the ash is the visual signature. The FULL design brief
(story, art direction, systems, milestones M0–M7) was given in the first
session — its operative parts are restated here and in `DEVLOG.md`; the
build plan summary is in `README.md` (milestone checklist).

## State (keep current)

- DONE: M0 bootstrap, M1 rendering core + look-dev street, M2 player &
  world kit (Ellen + Jonas + Birk walking the Act I street, candle
  interior, collision, scene manager), M3 systems — meters
  (VARME/BATTERI/FILTRE), Geiger + radiation field, synth radio (§4.4),
  dialogue + Danish subtitles, journal/map, localStorage saves, Act I
  beats 1–4 (story/act1Beats.ts). App-level singletons live in main.ts
  and are handed to act1 via Act1Deps; UI is a DOM overlay (ui/uiShell.ts).
- NEXT: M4 — Act I proper + Interlude A. Build out the full Act-I
  traversal network beyond the M2/M3 street cap (z ∈ [−150,+40]), more
  beats/dialogue, the road-out interlude. Per-act radio signal sets,
  battery/filter pickups + meter recovery items, and dialogue
  camera-takeover/DoF were deferred from M3 — fold in as the content needs.
- Read `DEVLOG.md` before working — it records every architectural
  decision and the bugs already found and fixed (incl. the M3 entry).

## Commands

- `npm run dev` → http://localhost:5173 ; `npm run typecheck` ; `npm run build`.
- Headless verification (no interactive browser available): keep the dev
  server running, then
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot=shots/x.png --window-size=1920,1080 --hide-scrollbars --virtual-time-budget=15000 --use-angle=metal "http://localhost:5173/?…"`.
  URL hooks in main.ts: `?scene=lookdev|roadA`, `?walk` (auto-hold W),
  `?spawn=x,z,yaw`, `?cam=x,y,z,tx,ty,tz`, `?stats` (console budget lines —
  capture with `--enable-logging=stderr 2>&1 | grep STATS`), `?noao`;
  UI hooks `?radio`, `?freq=NN.N`, `?journal`, `?sub`, `?interact`.
  Headless fps is software-GL — judge budgets (≤300 draw calls, ≤1.5 M
  tris), not fps. Read screenshots with the Read tool; judge full-res
  crops (`sips -c h w --cropOffset y x`), not thumbnails.
- HEADLESS CAVEAT: `--virtual-time-budget` barely advances the RAF/`clock`
  `elapsed`, so time-gated behaviour (intro delays, meter drain, CSS
  transitions) does NOT progress and cannot be screenshotted — only
  position/flag-driven state can. Verify time-evolved logic by logging
  (`console.log` + `--enable-logging=stderr`) or gate debug hooks on a frame
  count, not elapsed. The live browser uses real time and is unaffected.
- In-game debug: F3 perf HUD, F8 free-cam, 1/2/3 scene jump, G look-dev GUI.

## Hard conventions

- TypeScript strict; `npx tsc --noEmit` must stay at zero errors.
- ZERO per-frame allocations in update/render paths (module-scope scratch).
- Yaw convention project-wide: facing = (sin yaw, 0, cos yaw); actor groups
  face local +Z; rotation.y = yaw. Collision world→local uses the
  TRANSPOSE of [[c,s],[−s,c]] (see collision.ts — this was once inverted).
- Every world material goes through `patchWorldMaterial(mat, {ashAmount})`
  (src/graphics/worldMaterial.ts) — ONE shared onBeforeCompile injection
  for layered fog + ash-settle. scene.fog is NEVER used. Custom shaders
  fog via the exported ASK_* GLSL chunks. Interiors: ashAmount 0.
- All look values derive from PALETTE/ACT_CONFIGS (src/graphics/palette.ts);
  `spire` green appears ONLY in the epilogue. Chroma is rationed.
- Scenes implement GameScene (load/update/applyQuality?/dispose) and must
  dispose EVERYTHING (the SceneManager warns about leftovers). The post
  stack is persistent; scenes hand it their sun disc via setGodRaysSource.
- postprocessing gotchas: one CONVOLUTION effect per EffectPass (SMAA and
  CA are both); never dispose an EffectPass whose effects are shared;
  n8ao `gammaCorrection` must stay false; AgX happens in ToneMappingEffect
  (renderer.toneMapping = NoToneMapping), exposure via
  renderer.toneMappingExposure.
- Assets: Tier-B procedural only so far (zero downloads); anything external
  must be CC0 and recorded in CREDITS.md. In-world text Danish (æøå works
  in canvas), code/comments English. No gore, no weapons, no bodies.
- Determinism: all build-time randomness through seeded mulberry32.
- Commit per milestone; verify (typecheck + build + headless screenshots +
  budget stats) before committing. Keep DEVLOG.md updated as you go.

## Open technical debt

- DONE at M3 start: helper consolidation → src/core/math.ts (mulberry32,
  dampAngle, clamp, smoothstep, lerp, damp; applyPBR lives in textures.ts);
  TriggerZone/TriggerSet → src/core/triggers.ts; GameScene gained optional
  player/godRaysSource + SceneManager.onSwitch so main.ts glue is generic.
- Draw-call recovery: segmented actors cost ~17 draws each; Tier-A skinned
  characters (M7 fetch script) are the plan. (M3 street ~202 draws.)
- PCFSoftShadowMap deprecated in three r184 (falls back to PCF) — revisit
  shadow filtering at M7.
- Geiger mSv readout reads a touch low vs. distance (displayRate smoothing +
  player settling); calibrate by eye when Act I content lands.

## Working method

- Big milestones: write contracts/skeletons + lynchpin modules inline
  first, then fan out workflow agents with per-task spec files on disk
  (docs/m*-specs/ — the Workflow `args` param does not reliably reach
  scripts; agents Read their spec instead). Agents verify their own files
  with filtered tsc. Session limits may kill agents mid-run — check files
  for remaining `throw new Error('not implemented')` stubs and finish
  stragglers inline.
- After integration: headless screenshot loop → multi-lens visual critique
  (agents Read the screenshots) → apply fixes → 7-angle code review →
  commit. Iterate look-dev by eye via the G panel, then bake values into
  ACT_CONFIGS.
- When in doubt between more features and more beauty, choose beauty.
