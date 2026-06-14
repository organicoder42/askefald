import { mulberry32 } from '../core/math';

/**
 * WebAudio bootstrap (M3). The AudioContext is created lazily on the first
 * user gesture (browser autoplay policy) — until then `ctx` is null and
 * every audio module must stay silent without erroring (headless
 * verification never delivers a gesture).
 *
 * Bus graph: master → { sfx, radio, geiger } so story beats can duck a
 * whole category (e.g. radio under dialogue) without touching sources.
 *
 * Synthesis-time allocations (one-shot BufferSources, scheduled clicks) are
 * fine — the ZERO-alloc rule applies to per-frame update/render paths, so
 * keep per-frame work to setTargetAtTime / parameter writes only.
 */
export class AudioEngine {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private busNodes: { sfx: GainNode; radio: GainNode; geiger: GainNode } | null = null;
  private readyFns: Array<(ctx: AudioContext) => void> = [];
  private noiseCache = new Map<string, AudioBuffer>();
  private readonly unlock: () => void;
  private masterVolume = 0.9;

  constructor() {
    this.unlock = () => {
      this.start();
      window.removeEventListener('pointerdown', this.unlock);
      window.removeEventListener('keydown', this.unlock);
    };
    window.addEventListener('pointerdown', this.unlock);
    window.addEventListener('keydown', this.unlock);
  }

  /** Null until the first user gesture. */
  get ctx(): AudioContext | null {
    return this.context;
  }

  get sfx(): GainNode | null {
    return this.busNodes?.sfx ?? null;
  }

  get radio(): GainNode | null {
    return this.busNodes?.radio ?? null;
  }

  get geiger(): GainNode | null {
    return this.busNodes?.geiger ?? null;
  }

  /** Runs fn now if the context exists, else once on the unlocking gesture. */
  onReady(fn: (ctx: AudioContext) => void): void {
    if (this.context) fn(this.context);
    else this.readyFns.push(fn);
  }

  /**
   * Deterministic white-noise loop buffer (seeded mulberry32 — the
   * determinism rule covers audio too). Cached per (seconds, seed).
   */
  noiseBuffer(seconds = 2, seed = 1): AudioBuffer | null {
    if (!this.context) return null;
    const key = `${seconds}|${seed}`;
    let buf = this.noiseCache.get(key);
    if (!buf) {
      const rng = mulberry32(seed);
      const len = Math.floor(this.context.sampleRate * seconds);
      buf = this.context.createBuffer(1, len, this.context.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = rng() * 2 - 1;
      this.noiseCache.set(key, buf);
    }
    return buf;
  }

  setMasterVolume(v: number): void {
    this.masterVolume = v;
    if (this.context && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(v, this.context.currentTime, 0.05);
    }
  }

  private start(): void {
    if (this.context) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // no WebAudio (some headless runs): stay silent
    this.context = new Ctor();
    void this.context.resume();
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = this.masterVolume;
    this.masterGain.connect(this.context.destination);
    const mkBus = (gain: number): GainNode => {
      const g = this.context!.createGain();
      g.gain.value = gain;
      g.connect(this.masterGain!);
      return g;
    };
    this.busNodes = { sfx: mkBus(1), radio: mkBus(1), geiger: mkBus(1) };
    for (const fn of this.readyFns) fn(this.context);
    this.readyFns.length = 0;
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.unlock);
    window.removeEventListener('keydown', this.unlock);
    this.readyFns.length = 0;
    this.noiseCache.clear();
    void this.context?.close();
    this.context = null;
    this.masterGain = null;
    this.busNodes = null;
  }
}
