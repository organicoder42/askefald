/**
 * Quality presets (§6.9). Systems read settings at creation and subscribe
 * to onChange for live switching. All M1 systems must honour these.
 */
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  preset: QualityPreset;
  resolutionScale: number;
  shadowMapSize: number;
  /** Multiplier on baseline ash particle count (baseline = 40k). */
  particleMultiplier: number;
  aoEnabled: boolean;
  aoHalfRes: boolean;
  godRays: boolean;
  /** DoF is only ever active in dialogue/cutscene cameras, and only if allowed. */
  dofAllowed: boolean;
  ssr: boolean;
  ashFootprints: boolean;
  softParticles: boolean;
}

export const QUALITY_PRESETS: Record<QualityPreset, QualitySettings> = {
  low: {
    preset: 'low',
    resolutionScale: 0.75,
    shadowMapSize: 1024,
    particleMultiplier: 0.25,
    aoEnabled: false,
    aoHalfRes: true,
    godRays: false,
    dofAllowed: false,
    ssr: false,
    ashFootprints: false,
    softParticles: false,
  },
  medium: {
    preset: 'medium',
    resolutionScale: 1.0,
    shadowMapSize: 2048,
    particleMultiplier: 0.5,
    aoEnabled: true,
    aoHalfRes: true,
    godRays: true,
    dofAllowed: false,
    ssr: false,
    ashFootprints: true,
    softParticles: false,
  },
  high: {
    preset: 'high',
    resolutionScale: 1.0,
    shadowMapSize: 4096,
    particleMultiplier: 1.0,
    aoEnabled: true,
    aoHalfRes: true,
    godRays: true,
    dofAllowed: true,
    ssr: false,
    ashFootprints: true,
    softParticles: true,
  },
  ultra: {
    preset: 'ultra',
    resolutionScale: 1.0,
    shadowMapSize: 4096,
    particleMultiplier: 1.5,
    aoEnabled: true,
    aoHalfRes: false,
    godRays: true,
    dofAllowed: true,
    ssr: true,
    ashFootprints: true,
    softParticles: true,
  },
};

export class QualityManager {
  private listeners: Array<(s: QualitySettings) => void> = [];
  current: QualitySettings;

  constructor(preset: QualityPreset = 'high') {
    this.current = { ...QUALITY_PRESETS[preset] };
  }

  set(preset: QualityPreset): void {
    this.current = { ...QUALITY_PRESETS[preset] };
    for (const fn of this.listeners) fn(this.current);
  }

  /** Override individual toggles (settings menu, debug GUI). */
  override(partial: Partial<QualitySettings>): void {
    this.current = { ...this.current, ...partial };
    for (const fn of this.listeners) fn(this.current);
  }

  onChange(fn: (s: QualitySettings) => void): void {
    this.listeners.push(fn);
  }
}

export const qualityManager = new QualityManager('high');
