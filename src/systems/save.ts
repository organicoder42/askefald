import type { GameState, SaveDataV1 } from './gameState';
import { clamp } from '../core/math';
import { RADIO_FREQ_MIN, RADIO_FREQ_MAX } from './radio';

/**
 * Save system (M3 §7): versioned JSON in localStorage under
 * `askefald.save.<slot>`. GameState serializes meters/radio/flags/journal;
 * the caller supplies scene id + player pose and applies them on load
 * (player.spawn). Corrupt or version-mismatched payloads load as null —
 * never throw on bad data.
 *
 * Spec: docs/m3-specs/save.md
 */

const KEY_PREFIX = 'askefald.save.';

function isFinite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function isStringArray(a: unknown): a is string[] {
  return Array.isArray(a) && a.every((s) => typeof s === 'string');
}

/** Validate + normalize a parsed payload, or null if it is not a v1 save. */
function validate(raw: unknown): SaveDataV1 | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return null;
  if (typeof o.sceneId !== 'string') return null;

  const p = o.player as Record<string, unknown> | undefined;
  if (!p || !isFinite(p.x) || !isFinite(p.z) || !isFinite(p.yaw)) return null;

  const m = o.meters as Record<string, unknown> | undefined;
  if (!m || !isFinite(m.varme) || !isFinite(m.batteri) || !isFinite(m.filtre)) return null;

  const r = o.radio as Record<string, unknown> | undefined;
  if (!r || typeof r.on !== 'boolean' || !isFinite(r.freq)) return null;

  if (!isStringArray(o.flags) || !isStringArray(o.journal)) return null;

  return {
    version: 1,
    timestamp: isFinite(o.timestamp) ? o.timestamp : 0,
    sceneId: o.sceneId,
    player: { x: p.x, z: p.z, yaw: p.yaw },
    meters: {
      varme: clamp(m.varme, 0, 1),
      batteri: clamp(m.batteri, 0, 1),
      filtre: clamp(m.filtre, 0, 1),
    },
    radio: { on: r.on, freq: clamp(r.freq, RADIO_FREQ_MIN, RADIO_FREQ_MAX) },
    flags: o.flags,
    journal: o.journal,
  };
}

export class SaveSystem {
  private readonly state: GameState;

  constructor(state: GameState) {
    this.state = state;
  }

  /** Returns false when storage is unavailable (private mode, quota). */
  save(sceneId: string, player: { x: number; z: number; yaw: number }, slot = 'auto'): boolean {
    try {
      const data = this.state.serialize(sceneId, player);
      localStorage.setItem(KEY_PREFIX + slot, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  /** Parsed + validated payload, or null. Does NOT mutate GameState. */
  load(slot = 'auto'): SaveDataV1 | null {
    try {
      const raw = localStorage.getItem(KEY_PREFIX + slot);
      if (raw === null) return null;
      return validate(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  has(slot = 'auto'): boolean {
    try {
      return localStorage.getItem(KEY_PREFIX + slot) !== null;
    } catch {
      return false;
    }
  }

  clear(slot = 'auto'): void {
    try {
      localStorage.removeItem(KEY_PREFIX + slot);
    } catch {
      // storage unavailable — nothing to clear.
    }
  }
}
