# Task: survival meters — src/systems/meters.ts

Implement `Meters` against the frozen skeleton. Read
`docs/m3-specs/common.md` first, plus `src/systems/gameState.ts`.

## Rules (all rates in METER_RATES, fraction of full bar per second)

- VARME: if `env.nearHeat` → recover at `varmeRecoverAtHeat`.
  Else drain at `varmeDrainIndoors` when `env.indoors`, otherwise
  `varmeDrainOutdoors`.
- BATTERI: drain `batteriDrainRadio` while `env.radioOn`. No recovery in
  M3 (pickups come with M4 content).
- FILTRE: drain `filtreDrainAtFullRad × env.radiation` (linear in field
  intensity; the field is already 0 indoors by authoring, don't gate).
- Clamp all to [0,1] every update.
- `warning` getter: true if ANY meter < `METER_RATES.warnThreshold`.

The Meters class is the ONLY writer of `state.meters` (the save system
restores via GameState.applySave, which is fine). Keep update()
allocation-free — it's pure arithmetic on `state.meters`.

This is a small task — make it exact, documented and boring.
