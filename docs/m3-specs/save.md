# Task: save system — src/systems/save.ts

Implement `SaveSystem` against the frozen skeleton. Read
`docs/m3-specs/common.md` first, plus `src/systems/gameState.ts`
(SaveDataV1 is defined there).

- Storage key: `askefald.save.<slot>`; default slot "auto".
- `save()`: `state.serialize(sceneId, player)` → JSON.stringify →
  localStorage.setItem inside try/catch (private-mode/quota → return
  false). Return true on success.
- `load()`: getItem → JSON.parse → VALIDATE before returning:
  `version === 1`, `sceneId` string, `player.x/z/yaw` finite numbers,
  `meters.varme/batteri/filtre` finite numbers (clamp to [0,1] on the
  returned object), `radio.on` boolean / `radio.freq` finite, `flags` and
  `journal` arrays of strings. ANY failure (including getItem/parse
  throwing) → null. Never throw on bad data.
- `load()` does NOT mutate GameState — the caller decides when to apply
  (`state.applySave(data)`) because it must also spawn the player and
  possibly switch scene.
- `has()`: cheap — getItem !== null (inside try/catch).
- `clear()`: removeItem in try/catch.

Small task — exhaustive validation is the point. A malformed save from a
future version must degrade to "no save", never a crash.
