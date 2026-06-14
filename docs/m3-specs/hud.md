# Task: survival HUD — src/ui/hud.ts

Implement `Hud` against the frozen skeleton. Read
`docs/m3-specs/common.md` first, plus `src/ui/uiShell.ts`,
`src/systems/gameState.ts` and `src/systems/meters.ts` (import
`METER_RATES` for the warning threshold).

## Meters block — bottom-left (16 px inset)

A quiet `.ask-panel` (padding 10 12) with three rows, 7 px apart:
  `VARME    ▮▮▮▮▮▮▮▮▮▮——————`
- Row = label (`.ask-label`, fixed width ~64 px) + bar track (140 × 3 px,
  background chalkFaint) + fill (chalk) scaled with
  `transform: scaleX(value)` (transform-origin left, transition 0.25 s
  linear so drains read smoothly).
- Below `METER_RATES.warnThreshold` the FILL turns amber and pulses via a
  CSS animation class (opacity 1 ↔ 0.45, ~1.6 s ease-in-out infinite).
  Toggle the class only on threshold crossings.
- Read values from `state.meters` each update; write DOM only when a
  value moved ≥ 0.003 (cache last written).

## Geiger readout — bottom-right (16 px inset)

`.ask-panel`, right-aligned column:
- Label row: "GEIGER" (.ask-label) + a 5 px activity dot that steps
  through opacity levels by rate bucket (calm <1/s: chalkFaint; uneasy
  1–6: chalkDim; hot >6: amber + pulse class). Bucket changes only.
- Readout: convert `info.geigerRate` to the fiction's dose figure:
  `mSv = rate × 0.13`, formatted with Danish comma, one decimal, e.g.
  "0,4 mSv/t" (tabular-nums). Below 0.25/s show "0,0 mSv/t". Update only
  when the formatted string changes.

## Interaction prompt — centred, ~64% viewport height

Single line, `.ask-label` styling but chalk (not dim), letter-spacing
0.22em, e.g. "E — TÆND RADIOEN". Fade 120 ms in / 200 ms out.
`setPrompt(null)` hides. Re-setting the same string is a no-op.

## General

- `setVisible(false)` hides all three blocks (lookdev scene). Default
  visible.
- Constructor builds all DOM once; update() writes only deltas; zero
  allocations in update (number formatting allocates a string ONLY when
  the displayed value actually changed — that's acceptable and required).
- `dispose()` removes the nodes.
