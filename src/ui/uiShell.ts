/**
 * Shared DOM overlay shell for all in-game UI (M3). One fixed full-screen
 * root with pointer-events:none — interactive panels opt back in. All UI
 * modules build DOM through this so fonts/colors stay consistent and a
 * single dispose clears everything.
 *
 * Art direction: UI chroma is rationed like the world. Chalk (kridt) text
 * on near-black panels; amber (bål) appears ONLY for warnings and the
 * radio needle. In-world/diegetic text is Danish.
 */

export const UI_COLORS = {
  chalk: 'rgba(233, 231, 223, 0.92)', // PALETTE.kridt
  chalkDim: 'rgba(233, 231, 223, 0.55)',
  chalkFaint: 'rgba(233, 231, 223, 0.28)',
  amber: '#E8A23C', // PALETTE.baal — warnings + radio needle only
  panel: 'rgba(10, 12, 14, 0.55)',
  panelDeep: 'rgba(8, 10, 12, 0.82)',
} as const;

export const UI_FONT = "'Avenir Next', 'Helvetica Neue', system-ui, sans-serif";
export const UI_FONT_JOURNAL = "'Iowan Old Style', 'Palatino', 'Georgia', serif";

export class UiShell {
  readonly root: HTMLDivElement;
  private styleEl: HTMLStyleElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'ui-root';
    this.root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:500;overflow:hidden;' +
      `font-family:${UI_FONT};color:${UI_COLORS.chalk};` +
      '-webkit-font-smoothing:antialiased;user-select:none;';
    document.body.appendChild(this.root);
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = `
      #ui-root .ask-label {
        font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
        color: ${UI_COLORS.chalkDim};
      }
      #ui-root .ask-panel {
        background: ${UI_COLORS.panel}; border-radius: 2px;
        backdrop-filter: blur(2px);
      }
    `;
    document.head.appendChild(this.styleEl);
  }

  /** Create an element, optionally classed and attached (default: root). */
  el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    parent?: HTMLElement,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    (parent ?? this.root).appendChild(node);
    return node;
  }

  /** Append module-specific CSS to the shared sheet. */
  addStyle(css: string): void {
    this.styleEl.textContent += css;
  }

  dispose(): void {
    this.root.remove();
    this.styleEl.remove();
  }
}
