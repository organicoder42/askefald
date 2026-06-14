import type { UiShell } from './uiShell';
import { UI_COLORS, UI_FONT_JOURNAL } from './uiShell';
import type { GameState } from '../systems/gameState';
import { mulberry32, type Rng } from '../core/math';

/**
 * Journal + map overlay (M3 §5), toggled with J. A full-screen dark vellum
 * spread: left page lists unlocked entries (Ellen's Danish notes, serif),
 * right page is a hand-drawn canvas map of the Act I street with a small
 * marker at the player position. The canvas is redrawn on open/entry-
 * unlock, NOT per frame; only the marker moves.
 *
 * Spec: docs/m3-specs/journal.md
 */

export interface JournalEntry {
  id: string;
  /** Danish heading, e.g. "Dag 14 — Lejligheden". */
  title: string;
  /** Danish body text. */
  text: string;
}

const FADE_S = 0.16;
// World extent shown on the map (metres). North (= world +z) is UP.
const X_MIN = -42;
const X_MAX = 28;
const Z_MIN = -155;
const Z_MAX = 48;
const MAP_W = 420; // CSS px
const MAP_H = 560;

// CSS is per-shell; guard against duplicate injection if rebuilt.
const styledShells = new WeakSet<UiShell>();

export class JournalUi {
  private readonly state: GameState;
  private readonly entriesById: Map<string, JournalEntry>;
  private readonly layer: HTMLDivElement;
  private readonly entryList: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly marker: HTMLDivElement;

  private open = false;
  private hideTimer = 0;
  private mapDrawn = false;
  private entriesDirty = true;

  // Map projection.
  private readonly scale: number;
  private readonly offX: number;
  private readonly offY: number;

  // Player pose + last-applied marker transform (px / radians).
  private px = 0;
  private pz = 0;
  private pyaw = 0;
  private lastMx = -999;
  private lastMy = -999;
  private lastMyaw = 999;

  constructor(shell: UiShell, state: GameState, entries: readonly JournalEntry[]) {
    this.state = state;
    this.entriesById = new Map(entries.map((e) => [e.id, e]));

    const worldW = X_MAX - X_MIN;
    const worldH = Z_MAX - Z_MIN;
    this.scale = Math.min(MAP_W / worldW, MAP_H / worldH);
    this.offX = (MAP_W - worldW * this.scale) / 2;
    this.offY = (MAP_H - worldH * this.scale) / 2;

    if (!styledShells.has(shell)) {
      styledShells.add(shell);
      shell.addStyle(`
      #ui-root .ask-journal {
        position: absolute; inset: 0; display: none;
        align-items: center; justify-content: center;
        background: ${UI_COLORS.panelDeep};
        opacity: 0; transition: opacity 160ms ease;
        font-family: ${UI_FONT_JOURNAL};
      }
      #ui-root .ask-journal.ask-journal-on { opacity: 1; }
      #ui-root .ask-journal-head, #ui-root .ask-journal-hint {
        position: absolute; left: 0; right: 0; text-align: center;
      }
      #ui-root .ask-journal-head { top: 7vh; }
      #ui-root .ask-journal-hint { bottom: 6vh; }
      #ui-root .ask-journal-spread {
        display: flex; width: 100%; max-width: 980px; height: 76vh;
        background: rgba(20,22,24,0.92); border: 1px solid ${UI_COLORS.chalkFaint};
      }
      #ui-root .ask-journal-page {
        flex: 1; padding: 26px; overflow: hidden; position: relative;
      }
      #ui-root .ask-journal-page.left { border-right: 1px solid ${UI_COLORS.chalkFaint}; overflow-y: auto; }
      #ui-root .ask-journal-page.left::-webkit-scrollbar { width: 0; }
      #ui-root .ask-journal-entry { margin-bottom: 18px; }
      #ui-root .ask-journal-entry h3 {
        margin: 0 0 4px; font-size: 17px; font-weight: 600;
        color: ${UI_COLORS.chalk}; font-family: ${UI_FONT_JOURNAL};
      }
      #ui-root .ask-journal-entry p {
        margin: 0; font-size: 14px; line-height: 1.55; color: ${UI_COLORS.chalkDim};
      }
      #ui-root .ask-journal-empty { font-size: 14px; color: ${UI_COLORS.chalkFaint}; font-style: italic; }
      #ui-root .ask-journal-map { display: block; }
      #ui-root .ask-journal-marker {
        position: absolute; top: 0; left: 0; width: 10px; height: 10px;
        pointer-events: none; background: ${UI_COLORS.amber};
        clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
      }
    `);
    }

    this.layer = shell.el('div', 'ask-journal');
    shell.el('div', 'ask-label ask-journal-head', this.layer).textContent = 'DAGBOG';
    shell.el('div', 'ask-label ask-journal-hint', this.layer).textContent = 'J — LUK';
    const spread = shell.el('div', 'ask-journal-spread', this.layer);
    this.entryList = shell.el('div', 'ask-journal-page left', spread);
    const right = shell.el('div', 'ask-journal-page', spread);

    const wrap = shell.el('div', undefined, right);
    wrap.style.cssText = `position:relative;width:${MAP_W}px;height:${MAP_H}px;margin:0 auto;`;
    this.canvas = shell.el('canvas', 'ask-journal-map', wrap);
    this.marker = shell.el('div', 'ask-journal-marker', wrap);

    state.on('journal', () => {
      this.entriesDirty = true;
      if (this.open) this.renderEntries();
    });
  }

  toggle(): void {
    this.open = !this.open;
    if (this.open) {
      this.layer.style.display = 'flex';
      this.hideTimer = 0;
      // Force a reflow so the opacity:0 start state registers before the
      // class flip — otherwise the open fade snaps instead of easing.
      void this.layer.offsetWidth;
      this.layer.classList.add('ask-journal-on');
      if (!this.mapDrawn) {
        this.drawMap();
        this.mapDrawn = true;
      }
      if (this.entriesDirty) this.renderEntries();
      this.entryList.scrollTop = this.entryList.scrollHeight;
      // Force the marker to re-apply on next update.
      this.lastMx = -999;
    } else {
      this.layer.classList.remove('ask-journal-on');
      this.hideTimer = FADE_S;
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Player world position+yaw for the map marker (fed every frame). */
  setPlayerPos(x: number, z: number, yaw: number): void {
    this.px = x;
    this.pz = z;
    this.pyaw = yaw;
  }

  update(dt: number): void {
    if (!this.open) {
      if (this.hideTimer > 0) {
        this.hideTimer -= dt;
        if (this.hideTimer <= 0) this.layer.style.display = 'none';
      }
      return;
    }
    const mx = this.toX(this.px);
    const my = this.toY(this.pz);
    if (Math.abs(mx - this.lastMx) >= 0.5 || Math.abs(my - this.lastMy) >= 0.5 || Math.abs(this.pyaw - this.lastMyaw) >= 0.05) {
      this.lastMx = mx;
      this.lastMy = my;
      this.lastMyaw = this.pyaw;
      // Triangle points up at yaw 0; CSS rotate(yaw) maps to (sin,−cos) on screen.
      this.marker.style.transform = `translate(${mx - 5}px, ${my - 5}px) rotate(${this.pyaw}rad)`;
    }
  }

  dispose(): void {
    this.layer.remove();
  }

  // -- internals ----------------------------------------------------------

  private toX(x: number): number {
    return this.offX + (x - X_MIN) * this.scale;
  }
  private toY(z: number): number {
    return this.offY + (Z_MAX - z) * this.scale; // +z up
  }

  private renderEntries(): void {
    this.entriesDirty = false;
    this.entryList.textContent = '';
    const ids = this.state.journal;
    if (ids.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ask-journal-empty';
      empty.textContent = '— endnu ingen notater —';
      this.entryList.appendChild(empty);
      return;
    }
    for (const id of ids) {
      const entry = this.entriesById.get(id);
      if (!entry) continue;
      const wrap = document.createElement('div');
      wrap.className = 'ask-journal-entry';
      const h = document.createElement('h3');
      h.textContent = entry.title;
      const p = document.createElement('p');
      p.textContent = entry.text;
      wrap.appendChild(h);
      wrap.appendChild(p);
      this.entryList.appendChild(wrap);
    }
  }

  private drawMap(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = MAP_W * dpr;
    this.canvas.height = MAP_H * dpr;
    this.canvas.style.width = `${MAP_W}px`;
    this.canvas.style.height = `${MAP_H}px`;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const rng = mulberry32(7);
    const jit = (v: number) => v + (rng() * 2 - 1) * 1.5;

    // Jittered polyline through world points; optional double-stroke.
    const line = (pts: ReadonlyArray<readonly [number, number]>, color: string, w: number, doubled = false) => {
      const passes = doubled ? 2 : 1;
      for (let p = 0; p < passes; p++) {
        ctx.strokeStyle = color;
        ctx.lineWidth = w;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const cx = jit(this.toX(pts[i][0]));
          const cy = jit(this.toY(pts[i][1]));
          if (i === 0) ctx.moveTo(cx, cy);
          else ctx.lineTo(cx, cy);
        }
        ctx.stroke();
      }
    };
    // Hatched block outline.
    const block = (x0: number, x1: number, z0: number, z1: number) => {
      line(
        [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]],
        UI_COLORS.chalkFaint,
        1,
      );
      ctx.strokeStyle = UI_COLORS.chalkFaint;
      ctx.lineWidth = 0.6;
      const ax0 = this.toX(Math.min(x0, x1));
      const ax1 = this.toX(Math.max(x0, x1));
      const ay0 = this.toY(Math.max(z0, z1));
      const ay1 = this.toY(Math.min(z0, z1));
      for (let hx = ax0 + 6; hx < ax1; hx += 7) {
        ctx.beginPath();
        ctx.moveTo(hx, ay0);
        ctx.lineTo(Math.min(ax1, hx + (ay1 - ay0)), ay1);
        ctx.stroke();
      }
    };
    const label = (text: string, x: number, z: number, italic = true) => {
      ctx.fillStyle = UI_COLORS.chalkDim;
      ctx.font = `${italic ? 'italic ' : ''}11px ${UI_FONT_JOURNAL}`;
      ctx.fillText(text, this.toX(x), this.toY(z));
    };
    const mark = (x: number, z: number) => {
      const cx = this.toX(x);
      const cy = this.toY(z);
      ctx.strokeStyle = UI_COLORS.chalkDim;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx - 3, cy - 3);
      ctx.lineTo(cx + 3, cy + 3);
      ctx.moveTo(cx + 3, cy - 3);
      ctx.lineTo(cx - 3, cy + 3);
      ctx.stroke();
    };

    // Main street: roadway (double-stroked) + sidewalk edges.
    line([[-5.5, -150], [-5.5, 40]], UI_COLORS.chalkDim, 1.4, true);
    line([[5.5, -150], [5.5, 40]], UI_COLORS.chalkDim, 1.4, true);
    line([[-10, -150], [-10, 40]], UI_COLORS.chalkFaint, 1);
    line([[10, -150], [10, 40]], UI_COLORS.chalkFaint, 1);
    // Cross street at the top.
    line([[-40, 44], [26, 44]], UI_COLORS.chalkDim, 1.2);
    line([[-40, 56], [26, 56]], UI_COLORS.chalkDim, 1.2);

    // Left row (gap 8.5→5.5 is the gennemgang — left open).
    block(-22, -10, 8.5, 32);
    block(-22, -10, -20, 5.5);
    block(-22, -10, -41, -22.5);
    block(-22, -10, -135, -112);
    // Right row.
    block(10, 22, 13, 36);
    block(10, 22, -7.5, 10.5);
    block(10, 22, -36, -10);
    block(10, 22, -136, -115);

    // Courtyard + shed mark; connect the gennemgang to it.
    block(-34, -22, -1, 15);
    mark(-32, 13);
    line([[-22, 7], [-10, 7]], UI_COLORS.chalkFaint, 1);

    // The flat, the sign, rubble.
    line([[11, 21], [14, 21], [14, 24], [11, 24], [11, 21]], UI_COLORS.chalkDim, 1);
    label('lejligheden', 11, 19.5);
    mark(8, 2);
    label('skiltet', 9.5, 2);
    mark(-9.2, -55);
    mark(9.1, -18);
    mark(-9, -120);

    // Street name along the road.
    ctx.save();
    ctx.translate(this.toX(-7.5), this.toY(-70));
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = UI_COLORS.chalkDim;
    ctx.font = `italic 12px ${UI_FONT_JOURNAL}`;
    ctx.fillText('ØSTERGADE', 0, 0);
    ctx.restore();

    // Compass rose, top-right.
    const crX = MAP_W - 26;
    const crY = 26;
    ctx.strokeStyle = UI_COLORS.chalkDim;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(crX, crY + 12);
    ctx.lineTo(crX, crY - 12);
    ctx.moveTo(crX, crY - 12);
    ctx.lineTo(crX - 3, crY - 7);
    ctx.moveTo(crX, crY - 12);
    ctx.lineTo(crX + 3, crY - 7);
    ctx.stroke();
    ctx.fillStyle = UI_COLORS.chalkDim;
    ctx.font = `11px ${UI_FONT_JOURNAL}`;
    ctx.fillText('N', crX - 3, crY - 15);
  }
}
