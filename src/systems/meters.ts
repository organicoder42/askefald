import { clamp } from '../core/math';
import type { GameState } from './gameState';

/**
 * Survival meters simulation (M3 §4): VARME / BATTERI / FILTRE.
 * Owns ALL drain/recover rules — other systems only describe the
 * environment (MeterEnv); nothing else writes state.meters.
 *
 * Spec: docs/m3-specs/meters.md
 */

/** Per-frame environment sampled by the scene around the player. */
export interface MeterEnv {
  /** Player is under a roof (flat, passage, …). */
  indoors: boolean;
  /** Within a registered heat source's radius (candles, later fires). */
  nearHeat: boolean;
  /** Radiation field sample at the player, 0..1 (drives FILTRE drain). */
  radiation: number;
  /** Radio currently powered (drives BATTERI drain). */
  radioOn: boolean;
}

/** Tuning constants in fraction-per-second (1/seconds full→empty). */
export const METER_RATES = {
  varmeDrainOutdoors: 1 / 420,
  varmeDrainIndoors: 1 / 1800,
  varmeRecoverAtHeat: 1 / 25,
  batteriDrainRadio: 1 / 300,
  filtreDrainAtFullRad: 1 / 90,
  /** Below this fraction a meter is in warning state (HUD pulses amber). */
  warnThreshold: 0.25,
} as const;

export class Meters {
  private readonly state: GameState;

  constructor(state: GameState) {
    this.state = state;
  }

  /** Advance the simulation; clamps every meter to [0, 1]. */
  update(dt: number, env: MeterEnv): void {
    const m = this.state.meters;

    // VARME: heat sources dominate; otherwise indoors merely slows the loss.
    if (env.nearHeat) {
      m.varme += METER_RATES.varmeRecoverAtHeat * dt;
    } else if (env.indoors) {
      m.varme -= METER_RATES.varmeDrainIndoors * dt;
    } else {
      m.varme -= METER_RATES.varmeDrainOutdoors * dt;
    }

    // BATTERI: only the radio draws in M3 (no recovery until M4 pickups).
    if (env.radioOn) {
      m.batteri -= METER_RATES.batteriDrainRadio * dt;
    }

    // FILTRE: linear in field intensity (field is 0 indoors by authoring).
    m.filtre -= METER_RATES.filtreDrainAtFullRad * env.radiation * dt;

    m.varme = clamp(m.varme, 0, 1);
    m.batteri = clamp(m.batteri, 0, 1);
    m.filtre = clamp(m.filtre, 0, 1);
  }

  /** True while any meter sits below METER_RATES.warnThreshold. */
  get warning(): boolean {
    const m = this.state.meters;
    return (
      m.varme < METER_RATES.warnThreshold ||
      m.batteri < METER_RATES.warnThreshold ||
      m.filtre < METER_RATES.warnThreshold
    );
  }
}
