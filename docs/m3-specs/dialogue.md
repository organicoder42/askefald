# Task: dialogue + subtitles — src/systems/dialogue.ts + src/ui/subtitles.ts

Implement `DialogueRunner` and `SubtitleDisplay` against the frozen
skeletons. Read `docs/m3-specs/common.md` first, plus `src/ui/uiShell.ts`.

## DialogueRunner (systems/dialogue.ts)

- Sequencer over `DialogueLine[]`: show line i (subtitles.show), wait its
  duration, hide during `pauseAfter` (default 0.25 s), advance.
- Default duration: `1.1 + 0.055 × text.length`, clamped [1.6, 7] s.
- `play(lines, onDone?)` preempts any running sequence; the PREEMPTED
  sequence's onDone does NOT fire (document this in a comment).
  Empty array → immediately done (onDone fires).
- `advance()`: player skip — jump to the next line now (or finish the
  sequence if on the last line; onDone fires once).
- `stop()`: hide subtitles, clear state, no onDone.
- `active`: true from play() until the final line's pauseAfter completes.
- update(dt) is a tiny state machine: no allocations, no timers — pure
  dt accounting (the harness clock is virtual-time-friendly for headless
  screenshots).

## SubtitleDisplay (ui/subtitles.ts)

Cinematic subtitle block, centred horizontally, bottom ≈ 13vh:
- Speaker tag: `.ask-label` style (small caps, letterspaced, chalkDim),
  e.g. "JONAS", on its own line, margin-bottom 4 px.
- Text: chalk, 19–20 px, line-height 1.45, max-width 620 px, centred,
  `text-wrap: balance` if available. Soft backing for legibility against
  the ash sky: padding 10px 18px, background UI_COLORS.panel, radius 2px,
  plus a faint text-shadow (0 1px 2px rgba(0,0,0,.5)).
- Fade in 120 ms / out 220 ms via CSS opacity transition; `show()` while
  visible just swaps content (no re-fade); `hide()` fades out (keep the
  node, toggle a class).
- Danish text with æøå must render correctly (it will — just don't
  mangle entities; set textContent, never innerHTML).

No queueing logic in SubtitleDisplay — the runner owns timing.
