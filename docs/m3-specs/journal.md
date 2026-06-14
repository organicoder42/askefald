# Task: journal + map overlay — src/ui/journal.ts

Implement `JournalUi` against the frozen skeleton. Read
`docs/m3-specs/common.md` first, plus `src/ui/uiShell.ts` and
`src/systems/gameState.ts`. Use `mulberry32` for stroke jitter.

## Shell

- `toggle()` opens/closes; opening plays a 160 ms fade+4px-rise; closing
  fades 140 ms then display:none. `isOpen` true while shown.
- Full-screen dim layer (UI_COLORS.panelDeep), centred spread max-width
  980 px, height ≈ 76vh: two side-by-side "pages" with a 1 px chalkFaint
  divider. Pages: background rgba(20,22,24,0.92), 1 px chalkFaint border,
  padding 26 px. Serif `UI_FONT_JOURNAL` for content. Top-centre heading
  "DAGBOG" (.ask-label) and bottom-centre hint "J — LUK" (.ask-label).

## Left page — entries

- Renders the UNLOCKED entries: `state.journal` (ids, in unlock order)
  mapped through the `entries` array given to the constructor. Re-render
  on open and via `state.on('journal', …)` — never per frame.
- Entry: title (serif, 17 px, chalk, small margin) + body (serif, 14 px,
  line-height 1.55, chalkDim). Separator: 18 px gap. Overflow:
  `overflow-y: auto` (scrollbar styled thin or hidden; keyboard users
  just see the latest — newest entry scrolled into view on open).
- Zero entries: a single faint line "— endnu ingen notater —".

## Right page — hand-drawn map of the Act I street

A `<canvas>` (device-pixel-ratio-aware, ~420×560 CSS px) drawn ONCE on
open (and cached) in a hand-drawn chalk style: strokeStyle chalk/chalkDim,
lineWidth 1.4, every polyline vertex jittered ±1.5 px with a seeded
mulberry32 (seed 7) so the linework looks penned, slight double-stroke on
main roads. North (= world +z) is UP.

World→canvas: map world x ∈ [−42, 28], z ∈ [−155, 48]; uniform scale,
centred. Draw (world coords):
- Main street: two long lines at x = ±5.5 (roadway) plus sidewalk edge
  lines at x = ±10, z from −150 to 40.
- Cross street at the top: lines z = 44 and z = 56, x ∈ [−40, 26].
- Building blocks (light hatched rectangle outlines, chalkFaint):
  left row x ∈ [−22, −10]: z [32, 8.5] (block 1), [5.5, −20] (block 2 —
  the gap 8.5→5.5 between them is the GENNEMGANG, leave it open),
  [−22.5, −41] (block 3), and a far block z [−112, −135].
  right row x ∈ [10, 22]: z [36, 13] (block 1), [10.5, −7.5] (block 2),
  [−10, −36] (block 3), far block z [−115, −136].
- Courtyard: rectangle x [−34, −22], z [−1, 15] with a small shed mark in
  its NW corner; connect the gennemgang gap to it.
- The flat: small square at (12.5, 22.5), labelled "lejligheden" (serif
  italic 11 px, chalkDim).
- The sign: small × at (8, 2) labelled "skiltet".
- Rubble: three small dot clusters at (−9.2, −55), (9.1, −18), (−9, −120).
- A compass rose: small "N" + arrow, top-right corner of the page.
- Label the street "ØSTERGADE" (italic, along the road).

## Player marker

An absolutely positioned 10 px amber triangle (CSS clip-path) over the
canvas, translated to the player's map position and rotated by yaw
(`setPlayerPos`); update its transform only while open and only when
moved ≥ 0.5 px or rotated ≥ 0.05 rad. The canvas itself never redraws for
the marker.

`update(dt)` only smooths/applies the marker transform. `dispose()`
removes everything.
