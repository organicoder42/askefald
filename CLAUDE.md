# ASKEFALD — project notes for Claude

Cinematic third-person narrative survival game in Three.js. Denmark after a
nuclear winter; the ash is the visual signature. The FULL design brief
(story, art direction, systems, milestones M0–M7) was given in the first
session — its operative parts are restated here and in `DEVLOG.md`; the
build plan summary is in `README.md` (milestone checklist).

## State (keep current)

- DONE: M0 bootstrap, M1 rendering core + look-dev street, M2 player &
  world kit (Ellen + Jonas + Birk walking the Act I street, candle
  interior, collision, scene manager).
- NEXT: M3 systems — meters (VARME/BATTERI/FILTRE), Geiger, radio (tuning
  UI + synthesized audio, §4.4 signature mechanic), dialogue engine +
  Danish subtitles, journal/map, saves. Verification: vertical slice of
  Act I beats 1–4. Start with the deferred housekeeping (below).
- Read `DEVLOG.md` before working — it records every architectural
  decision and the bugs already found and fixed.

## Commands

- `npm run dev` → http://localhost:5173 ; `npm run typecheck` ; `npm run build`.
- Headless verification (no interactive browser available): keep the dev
  server running, then
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot=shots/x.png --window-size=1920,1080 --hide-scrollbars --virtual-time-budget=15000 --use-angle=metal "http://localhost:5173/?…"`.
  URL hooks in main.ts: `?scene=lookdev`, `?walk` (auto-hold W),
  `?spawn=x,z,yaw`, `?cam=x,y,z,tx,ty,tz`, `?stats` (console budget lines —
  capture with `--enable-logging=stderr 2>&1 | grep STATS`), `?noao`.
  Headless fps is software-GL — judge budgets (≤300 draw calls, ≤1.5 M
  tris), not fps. Read screenshots with the Read tool; judge full-res
  crops (`sips -c h w --cropOffset y x`), not thumbnails.
- In-game debug: F3 perf HUD, F8 free-cam, 1/2 scene jump, G look-dev GUI.

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

## Deferred housekeeping (do at M3 start)

- Consolidate duplicated helpers: mulberry32 (6 copies), dampAngle (4),
  applyPBR (3), hash/smooth-noise (2) → shared src/core modules.
- TriggerZone abstraction for interior exposure beats (act1_city has a
  hardcoded one-off for the flat).
- Generalize per-scene glue (godRaysSource/player) onto GameScene so
  main.ts stops special-casing act1.
- Draw-call recovery: segmented actors cost ~17 draws each; Tier-A skinned
  characters (M7 fetch script) are the plan.
- PCFSoftShadowMap deprecated in three r184 (falls back to PCF) — revisit
  shadow filtering at M7.

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
