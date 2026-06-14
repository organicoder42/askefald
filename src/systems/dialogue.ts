import type { SubtitleDisplay } from '../ui/subtitles';
import { clamp } from '../core/math';

/**
 * Dialogue engine (M3 §5): plays authored line sequences over the walking
 * game (no camera takeover in M3 — walk-and-talk). Reading time derives
 * from text length when no explicit duration is given. One sequence at a
 * time; a new play() preempts the old one.
 *
 * Spec: docs/m3-specs/dialogue.md
 */

export interface DialogueLine {
  /** Speaker tag shown in the subtitle ("ELLEN", "JONAS", "RADIO"). */
  speaker: string;
  /** Danish line (subtitles are the text channel; no VO in Tier B). */
  text: string;
  /** Seconds; default ≈ 1.1 + 0.055 × chars, clamped 1.6–7. */
  duration?: number;
  /** Extra silence after the line before the next starts (default 0.25). */
  pauseAfter?: number;
}

// State machine phases (numeric constants — isolatedModules forbids const enum).
const PHASE_IDLE = 0; // no sequence
const PHASE_LINE = 1; // subtitle visible, counting down the line's duration
const PHASE_PAUSE = 2; // subtitle hidden, counting down pauseAfter

const DEFAULT_PAUSE = 0.25;

function durationOf(line: DialogueLine): number {
  if (line.duration !== undefined) return line.duration;
  return clamp(1.1 + 0.055 * line.text.length, 1.6, 7);
}

export class DialogueRunner {
  private readonly subtitles: SubtitleDisplay;
  private lines: readonly DialogueLine[] | null = null;
  /** Current line index (during PHASE_PAUSE: the line just hidden). */
  private index = 0;
  private phase = PHASE_IDLE;
  /** Seconds remaining in the current phase (pure dt accounting, no timers). */
  private timer = 0;
  private onDone: (() => void) | null = null;

  constructor(subtitles: SubtitleDisplay) {
    this.subtitles = subtitles;
  }

  /**
   * Start a sequence (preempts any running one); onDone fires once at end.
   * NOTE: a preempted sequence's onDone callback is intentionally NEVER
   * fired — only the most recent play()'s callback can run.
   */
  play(lines: readonly DialogueLine[], onDone?: () => void): void {
    this.onDone = onDone ?? null;
    if (lines.length === 0) {
      this.subtitles.hide();
      this.lines = null;
      this.phase = PHASE_IDLE;
      this.finish(); // empty sequence: immediately done
      return;
    }
    this.lines = lines;
    this.index = 0;
    this.phase = PHASE_LINE;
    const first = lines[0];
    this.timer = durationOf(first);
    this.subtitles.show(first.speaker, first.text);
  }

  /** Player skip (E): jump to the next line, or end the sequence. */
  advance(): void {
    if (this.phase === PHASE_IDLE || this.lines === null) return;
    const next = this.index + 1;
    if (next >= this.lines.length) {
      this.subtitles.hide();
      this.finish();
      return;
    }
    // Content swap (no re-fade if a line was visible); skip any pause.
    this.index = next;
    const line = this.lines[next];
    this.phase = PHASE_LINE;
    this.timer = durationOf(line);
    this.subtitles.show(line.speaker, line.text);
  }

  /** Hard stop without onDone. */
  stop(): void {
    this.subtitles.hide();
    this.lines = null;
    this.phase = PHASE_IDLE;
    this.timer = 0;
    this.onDone = null;
  }

  update(dt: number): void {
    if (this.phase === PHASE_IDLE || this.lines === null) return;
    this.timer -= dt;
    // Carry overshoot into the next phase (virtual-time-friendly); a single
    // large dt may step through several lines.
    while (this.timer <= 0) {
      if (this.phase === PHASE_LINE) {
        this.subtitles.hide();
        this.phase = PHASE_PAUSE;
        this.timer += this.lines[this.index].pauseAfter ?? DEFAULT_PAUSE;
      } else {
        const next = this.index + 1;
        if (next >= this.lines.length) {
          this.finish();
          return;
        }
        this.index = next;
        const line = this.lines[next];
        this.phase = PHASE_LINE;
        this.timer += durationOf(line);
        this.subtitles.show(line.speaker, line.text);
      }
    }
  }

  /** True from play() until the final line's pauseAfter completes. */
  get active(): boolean {
    return this.phase !== PHASE_IDLE;
  }

  /** End the sequence; fires onDone at most once (cleared before the call). */
  private finish(): void {
    this.lines = null;
    this.phase = PHASE_IDLE;
    this.timer = 0;
    const cb = this.onDone;
    this.onDone = null;
    if (cb !== null) cb();
  }
}
