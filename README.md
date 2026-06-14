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

## Controls

| Key | Action |
|---|---|
| Click | grab mouse (pointer lock) |
| W/A/S/D + mouse | walk Ellen (third person) |
| Shift | brisk walk |
| R | tænd/sluk radioen (radio on/off) |
| ← / → | tune the dial (while the radio is on) |
| E | spring replik over / saml op (skip dialogue · pick up item) |
| J | dagbog + kort (journal + map) |
| F5 / F9 | quicksave / quickload |
| F3 | perf HUD |
| F8 | free-cam toggle (Q/E down/up, Shift fast) |
| 1 / 2 / 3 | scene jump: look-dev / Act I street / Interlude A road |
| G | look-dev tuning panel (look-dev scene) |

## Status

Milestone build (see `DEVLOG.md`):

- [x] M0 — bootstrap (engine loop, input, quality presets, perf HUD)
- [x] M1 — rendering core + look-dev street
- [x] M2 — player & world kit (Ellen + Jonas + Birk on the Act I street)
- [x] M3 — systems (meters, Geiger, synth radio, dialogue, journal/map, saves)
- [~] M4 — Act I + Interlude A (Interlude A road scene done)
- [ ] M5 — Act II
- [ ] M6 — Act III + epilogue
- [ ] M7 — polish & ship
