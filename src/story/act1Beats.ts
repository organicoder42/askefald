import { TriggerSet } from '../core/triggers';
import type { GameState } from '../systems/gameState';
import type { DialogueRunner, DialogueLine } from '../systems/dialogue';
import type { Radio } from '../systems/radio';
import type { Hud } from '../ui/hud';
import type { JournalEntry } from '../ui/journal';

/**
 * Act I beats 1–4 (M3 vertical slice). The scene calls update() once per
 * frame with the player's situation; beats are one-shot, guarded by story
 * flags so a restored save never replays them. All in-world text Danish.
 *
 * Beat 1 — Lejligheden: wake in the candle flat, intro dialogue, the radio
 *          prompt ("R — TÆND RADIOEN").
 * Beat 2 — Signalet: first sustained lock on a radio signal → Jonas reads
 *          the morse, journal + autosave.
 * Beat 3 — Gaden/Asken: stepping onto the street, then the first hot
 *          Geiger zone → mask dialogue, journal.
 * Beat 4 — Skiltet: the painted sign → Roskilde resolve, journal,
 *          autosave; the south fog edge closes the slice.
 */

export const ACT1_JOURNAL: JournalEntry[] = [
  {
    id: 'dag14-lejligheden',
    title: 'Dag 14 — Lejligheden',
    text:
      'Stearinlysene er ved at brænde ud. Jonas sover uroligt, og Birk vil ' +
      'ikke væk fra døren. Strømmen kom aldrig tilbage. I morgen går vi. ' +
      'Jeg skriver det her, så jeg ikke kan fortryde det.',
  },
  {
    id: 'dag14-signalet',
    title: 'Dag 14 — Signalet',
    text:
      'Radioen fandt noget i støjen: morse, otte bogstaver, igen og igen. ' +
      'ROSKILDE. Far lærte mig morse på kolonihavens kortbølge. Nu er det ' +
      'måske det eneste kort, vi har.',
  },
  {
    id: 'dag14-asken',
    title: 'Dag 14 — Asken',
    text:
      'Geigertælleren knitrer ved murbrokkerne. Asken ligger som sne, men ' +
      'man må ikke tænke på den som sne. Filtrene skal holde til Roskilde. ' +
      'Jonas’ maske slutter ikke tæt nok.',
  },
  {
    id: 'dag14-skiltet',
    title: 'Dag 14 — Skiltet',
    text:
      'Nogen har malet det med en bred pensel: DER ER IKKE MERE. GÅ MOD ' +
      'ROSKILDE. Malingen er løbet, som om ordene har stået og grædt. ' +
      'Vi går mod sydvest, langs banen.',
  },
];

const LINES_INTRO: DialogueLine[] = [
  { speaker: 'ELLEN', text: 'Jonas? Tag tørklædet på. Vi går nu.' },
  { speaker: 'JONAS', text: 'Er du sikker? Her er der i det mindste lys.' },
  { speaker: 'ELLEN', text: 'Lysene er næsten brændt ned. Og batterierne med.' },
];

const LINES_SIGNAL: DialogueLine[] = [
  { speaker: 'JONAS', text: 'Kan du høre det? Det er morse… R… O… S…' },
  { speaker: 'ELLEN', text: 'Roskilde. Ligesom skiltet på gaden siger.' },
  { speaker: 'JONAS', text: 'Tror du, der stadig er nogen?' },
  { speaker: 'ELLEN', text: 'Radioen siger der er. Det må være nok.' },
];

const LINES_STREET: DialogueLine[] = [
  { speaker: 'ELLEN', text: 'Hold dig bag mig. Og rør ikke ved asken.' },
  { speaker: 'JONAS', text: 'Birk! Kom så. Tæt på.' },
];

const LINES_GEIGER: DialogueLine[] = [
  { speaker: 'JONAS', text: 'Tælleren… den knitrer.' },
  { speaker: 'ELLEN', text: 'Det er murbrokkerne. Vi går udenom. Træk masken op.' },
];

const LINES_SIGN: DialogueLine[] = [
  { speaker: 'JONAS', text: '“Gå mod Roskilde.” Det er tredive kilometer, Ellen.' },
  { speaker: 'ELLEN', text: 'Toogtredive. Vi går langs banen, væk fra hovedvejen.' },
  { speaker: 'JONAS', text: 'Og hvis der ikke er noget derude?' },
  { speaker: 'ELLEN', text: 'Så er der i det mindste ikke det her.' },
];

const LINES_SOUTH: DialogueLine[] = [
  { speaker: 'ELLEN', text: 'Byen slipper op her. Vest, så syd. Kom.' },
];

// Story flag ids (saved): beats consult these, never internal booleans.
const FLAG_INTRO = 'act1.intro';
const FLAG_RADIO_ON = 'act1.radioOn';
const FLAG_SIGNAL = 'act1.signal';
const FLAG_STREET = 'act1.street';
const FLAG_GEIGER = 'act1.geiger';
const FLAG_SIGN = 'act1.sign';
const FLAG_SOUTH = 'act1.south';

export interface Act1BeatsDeps {
  state: GameState;
  dialogue: DialogueRunner;
  radio: Radio;
  hud: Hud;
  /** Persist the current pose+state (scene supplies slot/pose). */
  autosave(): void;
}

export class Act1Beats {
  private readonly d: Act1BeatsDeps;
  private readonly triggers = new TriggerSet();
  private introDelay = 1.5;
  private lockTime = 0;
  private promptShown = false;

  constructor(deps: Act1BeatsDeps) {
    this.d = deps;
    const { state, dialogue } = deps;

    // Beat 3 — the sign (spatial). Beat 4 south edge likewise.
    this.triggers.add({
      enter: { x0: 4.5, x1: 10.5, z0: -1.5, z1: 5.5 },
      once: true,
      onEnter: () => {
        if (!state.setFlag(FLAG_SIGN)) return;
        dialogue.play(LINES_SIGN, () => {
          state.unlockJournal('dag14-skiltet');
          deps.autosave();
        });
      },
    });
    this.triggers.add({
      enter: { x0: -10, x1: 10, z0: -150, z1: -138 },
      once: true,
      onEnter: () => {
        if (!state.setFlag(FLAG_SOUTH)) return;
        dialogue.play(LINES_SOUTH, () => deps.autosave());
      },
    });
  }

  /** Re-arm the non-flag transient state (story flags persist in GameState
   *  and gate the beats themselves, so a fresh scene never replays them). */
  reset(): void {
    this.introDelay = 1.5;
    this.lockTime = 0;
    this.promptShown = false;
    this.triggers.reset();
  }

  /** Per frame from the scene. insideFlat comes from the exposure zone. */
  update(
    dt: number,
    x: number,
    z: number,
    geigerIntensity: number,
    insideFlat: boolean,
  ): void {
    const { state, dialogue, radio, hud } = this.d;

    // Beat 1 — intro dialogue after a short hold, then the radio prompt.
    if (!state.hasFlag(FLAG_INTRO)) {
      this.introDelay -= dt;
      if (this.introDelay <= 0) {
        state.setFlag(FLAG_INTRO);
        dialogue.play(LINES_INTRO, () => {
          state.unlockJournal('dag14-lejligheden');
        });
      }
    }

    // Radio prompt: stands until the radio is first powered on.
    if (!state.hasFlag(FLAG_RADIO_ON)) {
      if (state.radio.on) {
        state.setFlag(FLAG_RADIO_ON);
        hud.setPrompt(null);
        this.promptShown = false;
      } else if (state.hasFlag(FLAG_INTRO) && !dialogue.active && !this.promptShown) {
        hud.setPrompt('R — TÆND RADIOEN');
        this.promptShown = true;
      }
    }

    // Beat 2 — sustained signal lock (≥ 1.5 s cumulative).
    if (!state.hasFlag(FLAG_SIGNAL) && state.hasFlag(FLAG_RADIO_ON)) {
      this.lockTime = radio.lockedSignal ? this.lockTime + dt : 0;
      if (this.lockTime >= 1.5) {
        state.setFlag(FLAG_SIGNAL);
        dialogue.play(LINES_SIGNAL, () => {
          state.unlockJournal('dag14-signalet');
          this.d.autosave();
        });
      }
    }

    // Beat 3a — first time out on the street (after the intro). Deliberately
    // does NOT wait on the signal beat: a player who steps out before tuning
    // in still gets the "stay close / don't touch the ash" line. A later
    // signal lock (beat 2) may preempt it via the dialogue runner — fine.
    if (!state.hasFlag(FLAG_STREET) && state.hasFlag(FLAG_INTRO) && !insideFlat && x < 10) {
      state.setFlag(FLAG_STREET);
      if (!dialogue.active) dialogue.play(LINES_STREET);
    }

    // Beat 3b — first hot Geiger zone.
    if (!state.hasFlag(FLAG_GEIGER) && geigerIntensity > 0.25) {
      state.setFlag(FLAG_GEIGER);
      dialogue.play(LINES_GEIGER, () => {
        state.unlockJournal('dag14-asken');
      });
    }

    this.triggers.update(x, z);
  }
}
