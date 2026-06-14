# M3 common spec — read this first

ASKEFALD is a cinematic third-person narrative survival game in Three.js
(Denmark after a nuclear winter). M3 adds the systems layer: survival
meters, Geiger counter, radio (the signature mechanic), dialogue with
Danish subtitles, journal/map, and saves.

Your task file names the skeleton file(s) you must implement. The exported
signatures in those skeletons are FROZEN CONTRACTS — other modules compile
against them. Replace every `throw new Error('not implemented')` with a
real implementation. You may add private members, module-private helpers
and non-exported constants freely. Do NOT edit any file outside your task.

## Hard rules

- TypeScript strict. Verify with `npx tsc --noEmit` from the repo root —
  it must report ZERO errors mentioning your files. (Other skeletons may
  still be mid-flight; ignore errors in files that are not yours, but
  there should normally be none.)
- ZERO allocations in per-frame update paths (no closures, no array/object
  literals, no string building unless the value actually changed). Build
  everything up front; reuse module-scope scratch.
- Determinism: any randomness uses `mulberry32` from `src/core/math.ts`
  with a fixed seed.
- In-world/UI text is DANISH (æøå is fine in DOM/canvas). Code, comments
  and identifiers are English. Comments state constraints, not narration.
- No gore, no weapons, no bodies.

## Art direction for UI (chroma is rationed)

Use the shared tokens from `src/ui/uiShell.ts`:
- `UI_COLORS.chalk / chalkDim / chalkFaint` for almost everything.
- `UI_COLORS.amber` ONLY for warnings and the radio needle.
- `UI_COLORS.panel / panelDeep` panel backgrounds; `UI_FONT` for HUD,
  `UI_FONT_JOURNAL` (serif) for journal/diegetic text.
- Tone: quiet, precise, cinematic. Small letter-spaced uppercase labels
  (`.ask-label` class exists). Thin lines. Nothing glossy, no borders
  thicker than 1px, radius ≤ 2px. Danish decimal comma in readouts
  ("96,4 MHz").

All UI DOM goes through the provided `UiShell` instance: `shell.el(tag,
class?, parent?)`, `shell.addStyle(css)`. The root is pointer-events:none;
opt panels back in with `pointer-events:auto` only if they need clicks
(M3 UI is keyboard-driven — you probably don't).

DOM update discipline: cache last-written values; write style/text only on
change. Bars move via `transform: scaleX()`. Pulsing/blinking uses a CSS
animation class that you toggle, not per-frame style writes.

## Audio rules

`AudioEngine` (src/audio/audioEngine.ts) wraps WebAudio:
- `engine.ctx` is NULL until the first user gesture (autoplay policy;
  headless never gets one). Every audio path must be silently inert when
  ctx is null — no errors, no retry spam. Build graphs in
  `engine.onReady(ctx => …)`.
- Buses: `engine.sfx`, `engine.radio`, `engine.geiger` (GainNodes routed
  to master). Connect to your bus, never to `ctx.destination`.
- `engine.noiseBuffer(seconds, seed)` gives a cached deterministic noise
  buffer.
- Build audio graphs ONCE; per-frame work is parameter automation only
  (`setTargetAtTime` etc.). One-shot BufferSources per scheduled event
  (Geiger clicks) are fine — that's the WebAudio idiom, not a per-frame
  alloc.

## Key shared APIs (already implemented — read the sources)

- `src/core/math.ts`: mulberry32/Rng, clamp, smoothstep, lerp, damp,
  dampAngle.
- `src/systems/gameState.ts`: `GameState` — meters {varme,batteri,filtre}
  0..1, radio {on,freq}, setFlag/hasFlag, unlockJournal/journal,
  on('flag'|'journal'), serialize/applySave (SaveDataV1).
- `src/ui/uiShell.ts`: UiShell, UI_COLORS, UI_FONT, UI_FONT_JOURNAL.
- `src/core/triggers.ts`: TriggerZone/TriggerSet (scene-side; you likely
  don't need it).

## Done criteria

1. No `not implemented` left in your files.
2. `npx tsc --noEmit` clean for your files.
3. Self-review your update() paths for allocations.
4. Your final message: list files completed + any deviations from spec
   (deviations need a one-line reason).
