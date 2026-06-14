import type { GameState } from './gameState';
import type { Meters } from './meters';
import type { GeigerCounter } from './geiger';
import type { Radio } from './radio';
import type { DialogueRunner } from './dialogue';
import type { SaveSystem } from './save';
import type { Hud } from '../ui/hud';
import type { RadioOverlay } from '../ui/radioOverlay';
import type { JournalUi } from '../ui/journal';

/**
 * The app-level gameplay systems (created once in main.ts, persisting across
 * scene switches). Every playable scene receives this bundle and orchestrates
 * the per-frame calls from the player's situation; scene-specific story logic
 * (beats, signals, radiation sources) is built inside the scene.
 */
export interface GameSystems {
  state: GameState;
  meters: Meters;
  geiger: GeigerCounter;
  radio: Radio;
  dialogue: DialogueRunner;
  hud: Hud;
  radioOverlay: RadioOverlay;
  journal: JournalUi;
  save: SaveSystem;
}
