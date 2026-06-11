# ASKEFALD

*Et fortællende overlevelsesspil i asken. / A narrative survival game in the ash.*

Danmark, den nære fremtid. Fjorten dage efter bomberne forlader elektrikeren
Ellen Vinter sin mørke København-lejlighed med sin nevø Jonas og følger to
svage radiosignaler vestpå.

Built entirely in Three.js. No engine, no downloaded assets required.

## Kørsel / Running

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build (dist/)
```

Works fully offline — all geometry, textures and audio are procedural (Tier B).

## Controls (debug, M1 look-dev)

| Key | Action |
|---|---|
| Click | grab mouse (pointer lock) |
| W/A/S/D + mouse | fly camera |
| Q / E | down / up |
| Shift | fast |
| F3 | perf HUD |
| G | look-dev tuning panel |

## Status

Milestone build (see `DEVLOG.md`):

- [x] M0 — bootstrap (engine loop, input, quality presets, perf HUD)
- [x] M1 — rendering core + look-dev street
- [ ] M2 — player & world kit
- [ ] M3 — systems (meters, radio, dialogue, saves)
- [ ] M4 — Act I + Interlude A
- [ ] M5 — Act II
- [ ] M6 — Act III + epilogue
- [ ] M7 — polish & ship
