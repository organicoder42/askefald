# Task: Geiger counter — src/systems/geiger.ts + src/audio/geigerAudio.ts

Implement `RadiationField`, `GeigerCounter`, `GeigerAudio` against the
frozen skeletons. Read `docs/m3-specs/common.md` first, plus
`src/audio/audioEngine.ts` and `src/core/math.ts`.

## RadiationField

- Stores a copy of the sources array.
- `sampleAt(x,z)`: for each source, contribution =
  `intensity × max(0, 1 − dist/radius)`; return the MAX contribution
  (no stacking — keeps authoring predictable). Plain loop, no allocations
  (compute dist from dx/dz, no Vector classes).

## GeigerCounter

- Click scheduling is a Poisson process driven by intensity:
  `rate = 0.18 + 28 × intensity²` clicks/second (ambient background ticks
  even at zero — the world is never clean; squared curve makes hot zones
  crackle).
- Maintain `nextIn` seconds; each update subtract dt; when ≤ 0 fire
  `audio.click(strength)` and draw the next interval from the exponential
  distribution: `nextIn = -ln(1 − u) / rate` with `u` from a mulberry32
  stream (fixed seed, e.g. 1213). Handle multiple clicks per frame (while
  loop) and re-derive `rate` when intensity changes — recompute each
  update, it's cheap.
- `click strength`: `0.4 + 0.6 × min(1, intensity × 1.4)` with ±20%
  deterministic jitter from the same rng.
- `displayRate`: exponentially smooth the *configured* rate toward its
  current value with ~0.35 s time constant (`damp` from core/math) — the
  HUD shows a needle-like settling figure, not raw click counts.
- `intensity` getter returns the last update's input.

## GeigerAudio

- Graph (built in `engine.onReady`): nothing persistent needed beyond a
  cached 60 ms noise buffer (`engine.noiseBuffer(0.06, 4242)`) and the
  `engine.geiger` bus reference.
- `click(strength)`: if no ctx → return. Create one-shot:
  BufferSource(noise) → BandPassFilter(centre 2800 + strength × 2600 Hz,
  Q ≈ 2.2) → Gain envelope: instant attack at `0.25 + 0.45 × strength`,
  exponential decay to 0.0001 over ~28 ms → geiger bus. start/stop ≤60 ms.
  One-shot node creation per click is correct WebAudio idiom.
- `dispose()`: drop references (one-shots clean themselves up).

The crackle must read as UNEASE, not alarm — short dry ticks, no reverb,
modest level (the radio and dialogue sit above it in the mix).
