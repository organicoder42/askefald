import type { AudioEngine } from './audioEngine';

/**
 * One-shot interface sound effects on the engine's `sfx` bus (M4). Cues are
 * tiny synthesized blips — no samples. Silent and error-free while the
 * AudioContext is null (pre-gesture / headless). One-shot node creation per
 * cue is the WebAudio idiom (cues are events, not per-frame work).
 */
export class Sfx {
  private readonly engine: AudioEngine;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  /** Soft two-tone confirm — picking an item up. */
  pickup(): void {
    const ctx = this.engine.ctx;
    const bus = this.engine.sfx;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    this.blip(ctx, bus, 620, t, 0.09, 0.12, 'sine');
    this.blip(ctx, bus, 880, t + 0.075, 0.12, 0.1, 'sine');
  }

  /** Low, dry denial — nothing to interact with / refused. */
  deny(): void {
    const ctx = this.engine.ctx;
    const bus = this.engine.sfx;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    this.blip(ctx, bus, 180, t, 0.12, 0.09, 'triangle');
  }

  private blip(
    ctx: AudioContext,
    bus: GainNode,
    freq: number,
    start: number,
    dur: number,
    gain: number,
    type: OscillatorType,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    g.connect(bus);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }
}
