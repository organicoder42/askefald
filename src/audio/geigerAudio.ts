import type { AudioEngine } from './audioEngine';

// Click envelope: instant attack, exponential decay — short dry ticks that
// read as unease, not alarm (no reverb, modest level under radio/dialogue).
const DECAY_S = 0.028;
const STOP_S = 0.06;
const FILTER_Q = 2.2;

/**
 * Geiger click synthesis (M3). Each click is a one-shot filtered noise/burst
 * on the engine's `geiger` bus. Must be silent and error-free while
 * engine.ctx is null (pre-gesture / headless).
 *
 * Spec: docs/m3-specs/geiger.md
 */
export class GeigerAudio {
  private readonly engine: AudioEngine;
  private noise: AudioBuffer | null = null;
  private bus: GainNode | null = null;
  private disposed = false;

  constructor(engine: AudioEngine) {
    this.engine = engine;
    engine.onReady(() => {
      if (this.disposed) return;
      this.noise = engine.noiseBuffer(0.06, 4242);
      this.bus = engine.geiger;
    });
  }

  /** Fire one click; strength 0..1 maps to level + brightness variation. */
  click(strength: number): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.noise || !this.bus) return;
    const now = ctx.currentTime;

    // One-shot node creation per scheduled click is the WebAudio idiom
    // (the ZERO-alloc rule covers per-frame update paths, not events).
    const src = ctx.createBufferSource();
    src.buffer = this.noise;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2800 + strength * 2600;
    filter.Q.value = FILTER_Q;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25 + 0.45 * strength, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + DECAY_S);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.bus);
    src.start(now);
    src.stop(now + STOP_S);
  }

  dispose(): void {
    // One-shots clean themselves up after stop(); just drop references.
    this.disposed = true;
    this.noise = null;
    this.bus = null;
  }
}
