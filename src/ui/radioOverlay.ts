import type { UiShell } from './uiShell';
import { UI_COLORS } from './uiShell';
import type { GameState } from '../systems/gameState';
import { RADIO_FREQ_MIN, RADIO_FREQ_MAX } from '../systems/radio';

/**
 * Radio tuning overlay (M3 §4.4) — bottom-centre, visible only while the
 * radio is on. A horizontal frequency band (88–108 MHz) with tick marks,
 * an amber needle at the tuned frequency, a Danish readout ("96,4 MHz" —
 * comma decimal) and a small signal-strength meter. Chalk on dark panel;
 * amber is reserved for the needle. DOM updates only when values change.
 *
 * Spec: docs/m3-specs/radio.md
 */

const SPAN = RADIO_FREQ_MAX - RADIO_FREQ_MIN; // 20 MHz
const FADE_S = 0.16;
const MAJOR_LABELS = [88, 93, 98, 103, 108];

export class RadioOverlay {
  private readonly state: GameState;
  private readonly panel: HTMLDivElement;
  private readonly readout: HTMLDivElement;
  private readonly needle: HTMLDivElement;
  private readonly bars: HTMLDivElement[] = [];

  private shown = false;
  private hideTimer = 0; // counts down a fade-out before display:none
  private lastFreq = -1;
  private lastLit = -1;

  constructor(shell: UiShell, state: GameState) {
    this.state = state;
    shell.addStyle(`
      #ui-root .ask-radio {
        position: absolute; left: 50%; bottom: 80px;
        transform: translateX(-50%);
        width: 440px; padding: 10px 14px 12px;
        opacity: 0; transition: opacity 150ms ease; display: none;
      }
      #ui-root .ask-radio.ask-radio-on { opacity: 1; }
      #ui-root .ask-radio-top {
        display: flex; justify-content: space-between; align-items: baseline;
        margin-bottom: 8px;
      }
      #ui-root .ask-radio-read {
        color: ${UI_COLORS.chalk}; font-size: 13px;
        font-variant-numeric: tabular-nums; letter-spacing: 0.04em;
      }
      #ui-root .ask-radio-band {
        position: relative; height: 28px; margin: 0 2px;
      }
      #ui-root .ask-radio-tick {
        position: absolute; bottom: 8px; width: 1px;
        background: ${UI_COLORS.chalkFaint};
      }
      #ui-root .ask-radio-tick.maj { background: ${UI_COLORS.chalkDim}; }
      #ui-root .ask-radio-tlabel {
        position: absolute; bottom: -4px; transform: translateX(-50%);
        font-size: 9px; color: ${UI_COLORS.chalkDim};
        font-variant-numeric: tabular-nums;
      }
      #ui-root .ask-radio-needle {
        position: absolute; top: 0; bottom: 6px; width: 1px;
        background: ${UI_COLORS.amber}; transform: translateX(-0.5px);
      }
      #ui-root .ask-radio-needle::before {
        content: ''; position: absolute; top: -1px; left: -3px;
        border-left: 4px solid transparent; border-right: 4px solid transparent;
        border-top: 5px solid ${UI_COLORS.amber};
      }
      #ui-root .ask-radio-meter {
        display: flex; gap: 3px; justify-content: flex-end;
        align-items: flex-end; height: 12px; margin-top: 8px;
      }
      #ui-root .ask-radio-bar {
        width: 3px; height: 100%; background: ${UI_COLORS.chalkFaint};
      }
      #ui-root .ask-radio-bar.lit { background: ${UI_COLORS.chalk}; }
    `);

    this.panel = shell.el('div', 'ask-panel ask-radio');
    const top = shell.el('div', 'ask-radio-top', this.panel);
    shell.el('span', 'ask-label', top).textContent = 'RADIO';
    this.readout = shell.el('div', 'ask-radio-read', top);

    // Static ruler — built once (DOM ticks, not canvas).
    const band = shell.el('div', 'ask-radio-band', this.panel);
    for (let mhz = RADIO_FREQ_MIN; mhz <= RADIO_FREQ_MAX + 0.001; mhz += 1) {
      const major = (Math.round(mhz) - RADIO_FREQ_MIN) % 5 === 0;
      const tick = shell.el('div', major ? 'ask-radio-tick maj' : 'ask-radio-tick', band);
      tick.style.left = `${((mhz - RADIO_FREQ_MIN) / SPAN) * 100}%`;
      tick.style.height = major ? '9px' : '4px';
    }
    for (const m of MAJOR_LABELS) {
      const lbl = shell.el('div', 'ask-radio-tlabel', band);
      lbl.style.left = `${((m - RADIO_FREQ_MIN) / SPAN) * 100}%`;
      lbl.textContent = String(m);
    }
    this.needle = shell.el('div', 'ask-radio-needle', band);

    const meter = shell.el('div', 'ask-radio-meter', this.panel);
    for (let i = 0; i < 5; i++) this.bars.push(shell.el('div', 'ask-radio-bar', meter));
  }

  /** Per-frame: show/hide from state.radio.on, move needle, set level. */
  update(dt: number, signalLevel: number): void {
    const on = this.state.radio.on;
    if (on !== this.shown) {
      this.shown = on;
      if (on) {
        this.panel.style.display = 'block';
        this.hideTimer = 0;
        // Add the on-class on the next style flush so the fade plays.
        this.panel.classList.add('ask-radio-on');
      } else {
        this.panel.classList.remove('ask-radio-on');
        this.hideTimer = FADE_S;
      }
    }
    if (!on) {
      if (this.hideTimer > 0) {
        this.hideTimer -= dt;
        if (this.hideTimer <= 0) this.panel.style.display = 'none';
      }
      return;
    }

    const freq = this.state.radio.freq;
    if (Math.abs(freq - this.lastFreq) >= 0.05) {
      this.lastFreq = freq;
      this.needle.style.left = `${((freq - RADIO_FREQ_MIN) / SPAN) * 100}%`;
      this.readout.textContent = `${freq.toFixed(1).replace('.', ',')} MHz`;
    }

    const lit = Math.ceil(Math.min(1, Math.max(0, signalLevel)) * 5);
    if (lit !== this.lastLit) {
      this.lastLit = lit;
      for (let i = 0; i < this.bars.length; i++) {
        this.bars[i].classList.toggle('lit', i < lit);
      }
    }
  }

  dispose(): void {
    this.panel.remove();
  }
}
