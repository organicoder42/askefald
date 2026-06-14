import type { GeigerAudio } from '../audio/geigerAudio';
import { clamp, damp, mulberry32, type Rng } from '../core/math';

/**
 * Radiation field + Geiger counter logic (M3 §4). The field is a set of
 * point sources with linear falloff; the counter converts the sampled
 * intensity into Poisson-distributed clicks (audio) and a smoothed
 * clicks/second readout (HUD). Allocation-free per frame.
 *
 * Spec: docs/m3-specs/geiger.md
 */

export interface RadiationSource {
  x: number;
  z: number;
  /** Metres — intensity falls linearly to 0 at this distance. */
  radius: number;
  /** 0..1 at the centre. */
  intensity: number;
}

export class RadiationField {
  private readonly sources: RadiationSource[];

  constructor(sources: readonly RadiationSource[]) {
    // Defensive copy — authoring data must not mutate under the field.
    this.sources = sources.map((s) => ({ x: s.x, z: s.z, radius: s.radius, intensity: s.intensity }));
  }

  /** Max over sources (no stacking), 0..1. */
  sampleAt(x: number, z: number): number {
    let max = 0;
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      const dx = x - s.x;
      const dz = z - s.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const falloff = 1 - dist / s.radius;
      if (falloff <= 0) continue;
      const contribution = s.intensity * falloff;
      if (contribution > max) max = contribution;
    }
    return max;
  }
}

// Ambient ticks even at zero intensity; squared curve makes hot zones crackle.
const RATE_AMBIENT = 0.18;
const RATE_SCALE = 28;
// displayRate settles with a ~0.35 s time constant (damp rate = 1/tau).
const DISPLAY_DAMP_RATE = 1 / 0.35;
// Floor on drawn intervals — u≈0 would otherwise yield a 0 s interval and spin.
const MIN_INTERVAL = 1e-4;

function clickRate(intensity: number): number {
  return RATE_AMBIENT + RATE_SCALE * intensity * intensity;
}

export class GeigerCounter {
  private readonly audio: GeigerAudio;
  private readonly rng: Rng;
  private nextIn: number;
  private smoothedRate = RATE_AMBIENT;
  private lastIntensity = 0;

  constructor(audio: GeigerAudio) {
    this.audio = audio;
    this.rng = mulberry32(1213);
    // Seed the first interval at the ambient rate (intensity 0).
    this.nextIn = this.drawInterval(RATE_AMBIENT);
  }

  /** Exponential inter-arrival draw, floored so a near-1 u can't stall it. */
  private drawInterval(rate: number): number {
    const u = Math.min(1 - 1e-9, this.rng());
    return Math.max(MIN_INTERVAL, -Math.log(1 - u) / rate);
  }

  /** Schedule clicks for this frame from the current field intensity 0..1. */
  update(dt: number, intensity: number): void {
    this.lastIntensity = intensity;
    const rate = clickRate(intensity);
    this.nextIn -= dt;
    while (this.nextIn <= 0) {
      const base = 0.4 + 0.6 * Math.min(1, intensity * 1.4);
      const jitter = 1 + (this.rng() * 2 - 1) * 0.2;
      this.audio.click(clamp(base * jitter, 0, 1));
      this.nextIn += this.drawInterval(rate);
    }
    this.smoothedRate = damp(this.smoothedRate, rate, DISPLAY_DAMP_RATE, dt);
  }

  /** Smoothed clicks/second for the HUD readout (≈0.2 ambient … ~30 hot). */
  get displayRate(): number {
    return this.smoothedRate;
  }

  /** Last sampled intensity 0..1 (HUD + meters read this). */
  get intensity(): number {
    return this.lastIntensity;
  }
}
