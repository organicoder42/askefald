import { TriggerSet } from '../core/triggers';
import type { GameState } from '../systems/gameState';
import type { DialogueRunner, DialogueLine } from '../systems/dialogue';
import type { Radio } from '../systems/radio';
import type { JournalEntry } from '../ui/journal';

/**
 * Interlude A — VEJEN UD (the road out of København). Three quiet beats over
 * the open highway west toward Roskilde: departing the city, the radio
 * signal coming in clear away from the concrete, and reaching the tracks of
 * those who walked here before. One-shot via GameState flags; unlocks
 * journal entries and autosaves. In-world text Danish.
 */

export const ROADA_JOURNAL: JournalEntry[] = [
  {
    id: 'interlude-vejen',
    title: 'Vejen ud',
    text:
      'Vi forlod byen ad den gamle landevej. Asken ligger over markerne som ' +
      'en sne, der aldrig smelter. Ingen biler kører længere — kun dem, der ' +
      'står og ruster, hvor folk forlod dem. Birk går forrest nu.',
  },
  {
    id: 'interlude-naer',
    title: 'Tættere på',
    text:
      'Væk fra murene er signalet rent. ROSKILDE, igen og igen, som et hjerte ' +
      'der stadig slår et sted derude. Vi går mod det. Det er det eneste, der ' +
      'er tilbage at gå imod.',
  },
];

const LINES_DEPART: DialogueLine[] = [
  { speaker: 'ELLEN', text: 'Se dig ikke tilbage, Jonas. Byen er færdig.' },
  { speaker: 'JONAS', text: 'Hvor langt er der til Roskilde?' },
  { speaker: 'ELLEN', text: 'Hvis skiltene passer — en dags march. Måske to.' },
];

const LINES_SIGNAL: DialogueLine[] = [
  { speaker: 'JONAS', text: 'Signalet… det er meget stærkere herude. Hører du det?' },
  { speaker: 'ELLEN', text: 'Væk fra murene, ja. Det betyder, vi går rigtigt.' },
];

const LINES_WAYPOINT: DialogueLine[] = [
  { speaker: 'JONAS', text: 'Der er fodspor i asken. Nogen er gået her før os.' },
  { speaker: 'ELLEN', text: 'Så følger vi dem. Kom. Det er ikke langt nu.' },
];

const FLAG_DEPART = 'roadA.depart';
const FLAG_SIGNAL = 'roadA.signal';
const FLAG_WAYPOINT = 'roadA.waypoint';

export interface RoadBeatsDeps {
  state: GameState;
  dialogue: DialogueRunner;
  radio: Radio;
  autosave(): void;
}

export class RoadBeats {
  private readonly d: RoadBeatsDeps;
  private readonly triggers = new TriggerSet();
  private departDelay = 1.4;
  private lockTime = 0;

  constructor(deps: RoadBeatsDeps) {
    this.d = deps;
    const { state, dialogue, autosave } = deps;

    // Beat C — the waypoint near the far fog edge (sets up Act II).
    this.triggers.add({
      enter: { x0: -7, x1: 7, z0: -250, z1: -232 },
      once: true,
      onEnter: () => {
        if (!state.setFlag(FLAG_WAYPOINT)) return;
        dialogue.play(LINES_WAYPOINT, () => autosave());
      },
    });
  }

  reset(): void {
    this.departDelay = 1.4;
    this.lockTime = 0;
    this.triggers.reset();
  }

  update(dt: number, x: number, z: number): void {
    const { state, dialogue, radio } = this.d;

    // Beat A — departing: a short beat after the scene settles.
    if (!state.hasFlag(FLAG_DEPART)) {
      this.departDelay -= dt;
      if (this.departDelay <= 0) {
        state.setFlag(FLAG_DEPART);
        dialogue.play(LINES_DEPART, () => state.unlockJournal('interlude-vejen'));
      }
    }

    // Beat B — the signal comes in clear (sustained lock out on the road).
    if (!state.hasFlag(FLAG_SIGNAL) && state.hasFlag(FLAG_DEPART)) {
      this.lockTime = radio.lockedSignal ? this.lockTime + dt : 0;
      if (this.lockTime >= 1.5) {
        state.setFlag(FLAG_SIGNAL);
        dialogue.play(LINES_SIGNAL, () => {
          state.unlockJournal('interlude-naer');
          this.d.autosave();
        });
      }
    }

    this.triggers.update(x, z);
  }
}
