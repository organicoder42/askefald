# Task: the radio (§4.4 signature mechanic) —
# src/systems/radio.ts + src/audio/radioAudio.ts + src/ui/radioOverlay.ts

The radio is the game's signature mechanic: Ellen follows weak signals
across Denmark by ear. Tuning must FEEL physical — static parting around
a carrier as the dial sweeps, the heterodyne whistle dropping as you
centre, the signal swelling as you walk toward the transmitter. Read
`docs/m3-specs/common.md` first, plus `src/audio/audioEngine.ts`,
`src/systems/gameState.ts`, `src/ui/uiShell.ts`.

## Radio (systems/radio.ts)

- State lives in `state.radio` (on/freq) — saves capture it. The Radio
  reads AND writes it; it owns a private `RadioAudio` instance.
- `toggle()`: refuse to power on when `state.meters.batteri <= 0`. On
  change call `audio.setOn(...)`.
- `tune(dir, dt)`: `freq += dir × 1.5 × dt`, clamped [RADIO_FREQ_MIN,
  RADIO_FREQ_MAX], written back to state.
- `update(dt, x, z)`:
  - If on and `state.meters.batteri <= 0` → force off (audio too).
  - Per signal: `lock = max(0, 1 − |freq − s.freq| / s.bandwidth)²`,
    `audible = lock × s.strengthAt(x, z)`.
  - Track the best `audible` signal → `signalLevel`; `lockedSignal` =
    that signal when its lock > 0.5 AND audible > 0.2, else null.
  - `staticLevel = 0.15 + 0.85 × (1 − bestAudible)` (static never fully
    dies — the world is irradiated).
  - `dialDelta` = signed MHz offset to the nearest signal whose
    positional strength > 0.05 (for the heterodyne); ±∞/clamped when none.
  - Drive `audio.update(dt, staticLevel, bestLock, dialDelta, locked)`.
  - When off, drive audio toward silence (setOn already ramps; update can
    early-out).
- No allocations in update (loop over a stored array; track best by
  index).

## RadioAudio (audio/radioAudio.ts)

Build ONCE in `engine.onReady`; silent inert when ctx null. Everything
routes through one `voiceGain` ("the radio's speaker") → a speaker
character chain → `engine.radio` bus. Speaker character: HighPass 280 Hz →
LowPass 3200 Hz (telephone-band grit; a gentle WaveShaper is optional).

Voices under voiceGain:
1. STATIC: looped BufferSource of `engine.noiseBuffer(2, 77)` → BandPass
   1600 Hz Q 0.5 → staticGain. Target gain ≈ 0.32 × staticLevel.
2. HETERODYNE: sine osc → hetGain. Frequency `120 + |dialDelta| × 750` Hz
   (clamp ≤ 2800). Gain `0.18 × (1 − lock) × max(0, 1 − |dialDelta|/1.6)`
   — whistles only near a carrier, vanishes when centred/locked.
3. MORSE (kind 'morse'): square-ish osc (use 'square', 620 Hz) →
   LowPass 1200 → morseGain. Precompute the message's on/off pattern once
   per signal change: dit 0.085 s, dah 3×, intra-char gap 1 dit,
   char gap 3, word gap 7, loop with 1.2 s tail silence. Advance a phase
   clock in update; gate morseGain `0.3 × lock² × strength` when the
   pattern is ON, else 0 (setTargetAtTime, τ ≈ 8 ms). Standard morse
   table A–Z 0–9; unknown chars = word gap.
4. VOICE (kind 'voice'): unintelligible distant speech placeholder. Two
   detuned sawtooth oscs (≈110/111.5 Hz) → three parallel BandPass
   formants (F1 ≈ 520, F2 ≈ 1180, F3 ≈ 2500, Q ≈ 9) whose centre
   frequencies WANDER slowly (LFO oscs at 0.31/0.47/0.23 Hz with gain
   120–300 Hz into filter.frequency, plus a 5.5 Hz AM tremolo at depth
   0.35 on the voice gain) → voiceSigGain `0.4 × lock² × strength`.
   It must murmur like a far-off announcer, never form words.

`setOn`: ramp voiceGain 0→0.9 / →0 over ~80 ms (setTargetAtTime). Also a
tiny power "pop": short 50 Hz blip at on-toggle (one-shot, optional but
nice). `update` does ONLY parameter automation. Oscillators start at
build time and run forever (gains gate them) — that's idiomatic and
cheap.

## RadioOverlay (ui/radioOverlay.ts)

Bottom-centre, ~440 px wide panel (`.ask-panel`), visible only while
`state.radio.on` (opacity fade ~150 ms via CSS transition; display:none
when fully hidden — track with a timeout or transitionend).

Layout, top to bottom:
1. Row: label "RADIO" (.ask-label) left; readout right: frequency with
   Danish comma + " MHz" (e.g. "96,4 MHz"), chalk, font-variant-numeric:
   tabular-nums.
2. The band: a 28 px tall strip. Tick marks every 1 MHz (chalkFaint,
   4 px), taller every 5 MHz (chalkDim, 9 px) with tiny labels 88/93/98/
   103/108. An AMBER needle (1px × full height + small triangle is fine)
   positioned by `left: %` — the ONLY amber element.
3. Signal meter: 5 thin vertical bars right-aligned; lit count =
   ceil(signalLevel × 5), lit = chalk, unlit = chalkFaint.

Update discipline: needle/readout only when freq changes ≥ 0.05 MHz; bar
states only when lit-count changes. Use a static ruler built once (DOM
ticks), not canvas.
