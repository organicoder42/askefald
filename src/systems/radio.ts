import type { AudioEngine } from '../audio/audioEngine';
import type { GameState } from './gameState';
import { RadioAudio } from '../audio/radioAudio';
import { clamp } from '../core/math';

/**
 * The radio — §4.4 signature mechanic (M3). A continuously tunable FM dial
 * (88.0–108.0 MHz) with a handful of authored signals. Tuning lock is a
 * squared proximity falloff inside each signal's bandwidth; audible signal
 * = lock × positional strength, so walking TOWARD a transmitter while
 * tuned is the core navigation verb. Owns its RadioAudio synth internally.
 *
 * State (on/freq) lives in GameState so saves capture it; battery DRAIN is
 * the meters system's job (it reads state.radio.on) but the radio forces
 * itself off when the battery hits zero.
 *
 * Spec: docs/m3-specs/radio.md
 */

export type RadioSignalKind = 'morse' | 'voice';

export interface RadioSignal {
  /** Centre frequency, MHz. */
  freq: number;
  /** Half-width in MHz within which lock rises from 0 to 1. */
  bandwidth: number;
  kind: RadioSignalKind;
  /** Morse payload (A–Z, 0–9, spaces) for kind 'morse'. */
  message?: string;
  /** Positional strength 0..1 at the listener (distance to transmitter). */
  strengthAt(x: number, z: number): number;
}

export const RADIO_FREQ_MIN = 88.0;
export const RADIO_FREQ_MAX = 108.0;
const TUNE_SPEED = 1.5; // MHz per second

export class Radio {
  private readonly state: GameState;
  private readonly audio: RadioAudio;
  private signals: readonly RadioSignal[] = [];

  private level = 0; // strongest audible signal 0..1
  private locked: RadioSignal | null = null;

  constructor(engine: AudioEngine, state: GameState) {
    this.state = state;
    this.audio = new RadioAudio(engine);
    // Sync the synth with any restored power state.
    this.audio.setOn(state.radio.on);
  }

  /** Replace the authored signal set (per scene/act). */
  setSignals(signals: readonly RadioSignal[]): void {
    this.signals = signals;
    this.level = 0;
    this.locked = null;
  }

  /** Power toggle; refuses to turn on with an empty battery. */
  toggle(): void {
    const r = this.state.radio;
    if (!r.on && this.state.meters.batteri <= 0) return;
    r.on = !r.on;
    this.audio.setOn(r.on);
    if (!r.on) {
      this.level = 0;
      this.locked = null;
    }
  }

  /** Push the synth to match state.radio.on after a save is applied. */
  syncFromState(): void {
    this.audio.setOn(this.state.radio.on);
  }

  /** Sweep the dial while held; dir −1/+1, speed ~1.5 MHz/s. */
  tune(dir: -1 | 1, dt: number): void {
    const r = this.state.radio;
    r.freq = clamp(r.freq + dir * TUNE_SPEED * dt, RADIO_FREQ_MIN, RADIO_FREQ_MAX);
  }

  /** Per-frame: evaluate locks at the listener position, drive the synth. */
  update(dt: number, x: number, z: number): void {
    const r = this.state.radio;

    // Dead battery forces the radio off.
    if (r.on && this.state.meters.batteri <= 0) {
      r.on = false;
      this.audio.setOn(false);
    }
    if (!r.on) {
      this.level = 0;
      this.locked = null;
      return;
    }

    let bestAudible = 0;
    let bestLock = 0;
    let best: RadioSignal | null = null;
    // Nearest signal (by dial distance) with usable positional strength —
    // drives the heterodyne whistle. Sentinel large delta => no whistle.
    let nearestDelta = 99;
    let nearestAbs = 99;

    for (let i = 0; i < this.signals.length; i++) {
      const s = this.signals[i];
      const strength = s.strengthAt(x, z);
      const norm = Math.abs(r.freq - s.freq) / s.bandwidth;
      const lin = Math.max(0, 1 - norm);
      const lock = lin * lin;
      const audible = lock * strength;
      if (audible > bestAudible) {
        bestAudible = audible;
        bestLock = lock;
        best = s;
      }
      if (strength > 0.05) {
        const signed = s.freq - r.freq;
        const abs = Math.abs(signed);
        if (abs < nearestAbs) {
          nearestAbs = abs;
          nearestDelta = signed;
        }
      }
    }

    this.level = bestAudible;
    this.locked = best !== null && bestLock > 0.5 && bestAudible > 0.2 ? best : null;

    // Static never fully dies — the world is irradiated.
    const staticLevel = 0.15 + 0.85 * (1 - bestAudible);
    this.audio.update(dt, staticLevel, bestLock, bestAudible, nearestDelta, this.locked);
  }

  /** Strongest audible signal level 0..1 (lock × strength) — UI + beats. */
  get signalLevel(): number {
    return this.level;
  }

  /** The signal currently locked above 0.5, else null. */
  get lockedSignal(): RadioSignal | null {
    return this.locked;
  }

  dispose(): void {
    this.audio.dispose();
  }
}
