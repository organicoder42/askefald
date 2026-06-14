import type { UiShell } from './uiShell';
import { UI_COLORS } from './uiShell';
import type { GameState, MeterState } from '../systems/gameState';
import { METER_RATES } from '../systems/meters';

/**
 * Survival HUD (M3 §4): bottom-left meter bars VARME / BATTERI / FILTRE
 * (Danish labels, thin chalk bars on a dark panel; a bar pulses amber below
 * its warning threshold), bottom-right Geiger readout (smoothed clicks/s as
 * "0,4 mSv" style figure + activity blip), and a centred interaction prompt
 * line ("E — TÆND RADIOEN"). Bars use transform:scaleX and update only on
 * change ≥0.3% — zero layout thrash, zero per-frame allocations.
 *
 * Spec: docs/m3-specs/hud.md
 */

export interface HudFrameInfo {
  /** Smoothed Geiger clicks/second (GeigerCounter.displayRate). */
  geigerRate: number;
}

/** Per-meter DOM row + last-written caches (built once in the constructor). */
interface MeterRow {
  key: keyof MeterState;
  fill: HTMLDivElement;
  lastValue: number;
  lastWarn: boolean;
}

// Minimum meter delta before the bar transform is rewritten.
const METER_EPSILON = 0.003;
// Fictional dose conversion: mSv/h per click/s.
const MSV_PER_RATE = 0.13;
// Below this rate the readout clamps to "0,0 mSv/t".
const RATE_FLOOR = 0.25;

// Activity-dot backgrounds by rate bucket (hot bucket uses the warn class).
const DOT_COLORS: readonly string[] = [UI_COLORS.chalkFaint, UI_COLORS.chalkDim, ''];

// CSS is per-shell; guard against duplicate injection if a Hud is rebuilt.
const styledShells = new WeakSet<UiShell>();

export class Hud {
  private readonly state: GameState;
  private readonly metersPanel: HTMLDivElement;
  private readonly geigerPanel: HTMLDivElement;
  private readonly promptEl: HTMLDivElement;
  private readonly dotEl: HTMLDivElement;
  private readonly doseEl: HTMLDivElement;
  private readonly rows: MeterRow[];

  private lastDoseTenths = -1;
  private lastBucket = -1;
  private promptText: string | null = null;
  private visible = true;

  constructor(shell: UiShell, state: GameState) {
    this.state = state;

    if (!styledShells.has(shell)) {
      styledShells.add(shell);
      shell.addStyle(`
      #ui-root .ask-hud-meters {
        position: absolute; left: 16px; bottom: 16px; padding: 10px 12px;
      }
      #ui-root .ask-hud-row { display: flex; align-items: center; }
      #ui-root .ask-hud-row + .ask-hud-row { margin-top: 7px; }
      #ui-root .ask-hud-row .ask-label { width: 64px; }
      #ui-root .ask-hud-track {
        width: 140px; height: 3px; background: ${UI_COLORS.chalkFaint};
      }
      #ui-root .ask-hud-fill {
        width: 100%; height: 100%; background: ${UI_COLORS.chalk};
        transform-origin: left center; transition: transform 0.25s linear;
      }
      #ui-root .ask-hud-warn {
        background: ${UI_COLORS.amber};
        animation: ask-hud-pulse 1.6s ease-in-out infinite;
      }
      @keyframes ask-hud-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.45; }
      }
      #ui-root .ask-hud-geiger {
        position: absolute; right: 16px; bottom: 16px; padding: 10px 12px;
        display: flex; flex-direction: column; align-items: flex-end;
      }
      #ui-root .ask-hud-geiger-top { display: flex; align-items: center; gap: 6px; }
      #ui-root .ask-hud-dot {
        width: 5px; height: 5px; border-radius: 50%;
        background: ${UI_COLORS.chalkFaint};
      }
      #ui-root .ask-hud-dose {
        margin-top: 4px; font-size: 13px; color: ${UI_COLORS.chalk};
        font-variant-numeric: tabular-nums;
      }
      #ui-root .ask-hud-prompt {
        position: absolute; left: 0; right: 0; top: 64%; text-align: center;
        font-size: 12px; letter-spacing: 0.22em; text-transform: uppercase;
        color: ${UI_COLORS.chalk};
        opacity: 0; transition: opacity 0.2s ease;
      }
      #ui-root .ask-hud-prompt.ask-hud-prompt-on {
        opacity: 1; transition: opacity 0.12s ease;
      }
      `);
    }

    // Meters block (bottom-left).
    this.metersPanel = shell.el('div', 'ask-panel ask-hud-meters');
    const labels: Array<[keyof MeterState, string]> = [
      ['varme', 'VARME'],
      ['batteri', 'BATTERI'],
      ['filtre', 'FILTRE'],
    ];
    this.rows = labels.map(([key, label]) => {
      const row = shell.el('div', 'ask-hud-row', this.metersPanel);
      shell.el('span', 'ask-label', row).textContent = label;
      const track = shell.el('div', 'ask-hud-track', row);
      const fill = shell.el('div', 'ask-hud-fill', track);
      // Seed transform so the first frame never animates from full width.
      const v = state.meters[key];
      fill.style.transform = `scaleX(${v})`;
      return { key, fill, lastValue: v, lastWarn: false };
    });
    // Apply initial warn state (e.g. when constructed from a low save).
    for (const row of this.rows) {
      if (row.lastValue < METER_RATES.warnThreshold) {
        row.lastWarn = true;
        row.fill.classList.add('ask-hud-warn');
      }
    }

    // Geiger readout (bottom-right).
    this.geigerPanel = shell.el('div', 'ask-panel ask-hud-geiger');
    const top = shell.el('div', 'ask-hud-geiger-top', this.geigerPanel);
    shell.el('span', 'ask-label', top).textContent = 'GEIGER';
    this.dotEl = shell.el('div', 'ask-hud-dot', top);
    this.doseEl = shell.el('div', 'ask-hud-dose', this.geigerPanel);
    this.doseEl.textContent = '0,0 mSv/t';
    this.lastDoseTenths = 0;

    // Interaction prompt (centred, ~64% viewport height).
    this.promptEl = shell.el('div', 'ask-hud-prompt');
  }

  update(_dt: number, info: HudFrameInfo): void {
    // Meter bars: write transform only on movement ≥ METER_EPSILON; toggle
    // the amber pulse class only on warn-threshold crossings.
    const meters = this.state.meters;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const v = meters[row.key];
      if (Math.abs(v - row.lastValue) >= METER_EPSILON) {
        row.lastValue = v;
        row.fill.style.transform = `scaleX(${v})`;
      }
      const warn = v < METER_RATES.warnThreshold;
      if (warn !== row.lastWarn) {
        row.lastWarn = warn;
        row.fill.classList.toggle('ask-hud-warn', warn);
      }
    }

    // Geiger activity dot: calm <1/s, uneasy 1–6/s, hot >6/s.
    const rate = info.geigerRate;
    const bucket = rate < 1 ? 0 : rate <= 6 ? 1 : 2;
    if (bucket !== this.lastBucket) {
      this.lastBucket = bucket;
      this.dotEl.style.background = DOT_COLORS[bucket];
      this.dotEl.classList.toggle('ask-hud-warn', bucket === 2);
    }

    // Dose readout: rebuild the string only when the displayed tenth moves.
    const tenths = rate < RATE_FLOOR ? 0 : Math.round(rate * MSV_PER_RATE * 10);
    if (tenths !== this.lastDoseTenths) {
      this.lastDoseTenths = tenths;
      const whole = (tenths / 10) | 0;
      this.doseEl.textContent = `${whole},${tenths - whole * 10} mSv/t`;
    }
  }

  /** Interaction prompt (null hides). */
  setPrompt(text: string | null): void {
    if (text === this.promptText) return;
    this.promptText = text;
    if (text === null) {
      this.promptEl.classList.remove('ask-hud-prompt-on');
    } else {
      this.promptEl.textContent = text;
      this.promptEl.classList.add('ask-hud-prompt-on');
    }
  }

  /** Whole-HUD visibility (lookdev scene hides it). */
  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    const display = v ? '' : 'none';
    this.metersPanel.style.display = display;
    this.geigerPanel.style.display = display;
    this.promptEl.style.display = display;
  }

  dispose(): void {
    this.metersPanel.remove();
    this.geigerPanel.remove();
    this.promptEl.remove();
  }
}
