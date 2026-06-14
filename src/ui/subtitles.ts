import { UI_COLORS, type UiShell } from './uiShell';

/**
 * Subtitle display (M3 §5): centred above the lower screen edge, cinematic
 * style — speaker tag in letter-spaced small caps (chalk-dim), line text in
 * chalk with a soft dark backing for legibility against ash sky. Fades in
 * ~120 ms / out ~220 ms. Danish text (æøå).
 *
 * Spec: docs/m3-specs/dialogue.md
 */
export class SubtitleDisplay {
  private readonly box: HTMLDivElement;
  private readonly speakerEl: HTMLDivElement;
  private readonly textEl: HTMLDivElement;
  // Cache last-written values; DOM writes only on change.
  private lastSpeaker = '';
  private lastText = '';
  private visible = false;

  constructor(shell: UiShell) {
    shell.addStyle(`
      #ui-root .ask-sub {
        position: absolute; left: 50%; bottom: 13vh;
        transform: translateX(-50%);
        max-width: 620px; padding: 10px 18px;
        background: ${UI_COLORS.panel}; border-radius: 2px;
        text-align: center;
        text-shadow: 0 1px 2px rgba(0,0,0,.5);
        opacity: 0; transition: opacity 220ms ease;
      }
      #ui-root .ask-sub.ask-sub-on { opacity: 1; transition-duration: 120ms; }
      #ui-root .ask-sub-speaker { display: block; margin-bottom: 4px; }
      #ui-root .ask-sub-text {
        color: ${UI_COLORS.chalk}; font-size: 19px; line-height: 1.45;
        text-wrap: balance;
      }
    `);
    this.box = shell.el('div', 'ask-sub');
    this.speakerEl = shell.el('div', 'ask-label ask-sub-speaker', this.box);
    this.textEl = shell.el('div', 'ask-sub-text', this.box);
  }

  /** Show (fade in) or, if already visible, swap content with no re-fade. */
  show(speaker: string, text: string): void {
    if (speaker !== this.lastSpeaker) {
      this.lastSpeaker = speaker;
      // textContent only — never innerHTML (Danish æøå must pass untouched).
      this.speakerEl.textContent = speaker;
      this.speakerEl.style.display = speaker === '' ? 'none' : 'block';
    }
    if (text !== this.lastText) {
      this.lastText = text;
      this.textEl.textContent = text;
    }
    if (!this.visible) {
      this.visible = true;
      this.box.classList.add('ask-sub-on');
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.box.classList.remove('ask-sub-on');
  }

  dispose(): void {
    this.box.remove();
  }
}
