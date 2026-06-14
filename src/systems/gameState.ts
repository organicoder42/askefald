/**
 * Central mutable game state (M3): survival meters, story flags, journal
 * unlocks and radio state — everything a save file captures, in one place.
 * Systems mutate it; the HUD and save system read it. Listeners fire on
 * discrete changes (flags/journal), never per frame.
 */

export interface MeterState {
  /** 0..1 — body warmth; drains outdoors, recovers at heat sources. */
  varme: number;
  /** 0..1 — shared battery for the radio (and later the torch). */
  batteri: number;
  /** 0..1 — mask filter life; drains with radiation/dust exposure. */
  filtre: number;
}

export interface RadioState {
  on: boolean;
  /** Tuned frequency in MHz, 88.0–108.0. */
  freq: number;
}

export interface SaveDataV1 {
  version: 1;
  timestamp: number;
  sceneId: string;
  player: { x: number; z: number; yaw: number };
  meters: MeterState;
  radio: RadioState;
  flags: string[];
  journal: string[];
}

export type StateEventKind = 'flag' | 'journal';

export class GameState {
  readonly meters: MeterState = { varme: 1, batteri: 0.8, filtre: 1 };
  readonly radio: RadioState = { on: false, freq: 96.0 };
  private flagSet = new Set<string>();
  private journalIds: string[] = [];
  private listeners: Record<StateEventKind, Array<(id: string) => void>> = {
    flag: [],
    journal: [],
  };

  /** Returns true when newly set (one-shot beat guards key off this). */
  setFlag(id: string): boolean {
    if (this.flagSet.has(id)) return false;
    this.flagSet.add(id);
    for (const fn of this.listeners.flag) fn(id);
    return true;
  }

  hasFlag(id: string): boolean {
    return this.flagSet.has(id);
  }

  /** Returns true when newly unlocked. */
  unlockJournal(id: string): boolean {
    if (this.journalIds.includes(id)) return false;
    this.journalIds.push(id);
    for (const fn of this.listeners.journal) fn(id);
    return true;
  }

  get journal(): readonly string[] {
    return this.journalIds;
  }

  /** Subscribe to discrete state changes; returns an unsubscribe function. */
  on(kind: StateEventKind, fn: (id: string) => void): () => void {
    const arr = this.listeners[kind];
    arr.push(fn);
    return () => {
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    };
  }

  serialize(sceneId: string, player: { x: number; z: number; yaw: number }): SaveDataV1 {
    return {
      version: 1,
      timestamp: Date.now(),
      sceneId,
      player: { ...player },
      meters: { ...this.meters },
      radio: { ...this.radio },
      flags: [...this.flagSet],
      journal: [...this.journalIds],
    };
  }

  /** Restores meters/radio/flags/journal; scene + player are the caller's. */
  applySave(data: SaveDataV1): void {
    Object.assign(this.meters, data.meters);
    Object.assign(this.radio, data.radio);
    this.flagSet = new Set(data.flags);
    this.journalIds = [...data.journal];
  }

  resetForNewGame(): void {
    this.meters.varme = 1;
    this.meters.batteri = 0.8;
    this.meters.filtre = 1;
    this.radio.on = false;
    this.radio.freq = 96.0;
    this.flagSet.clear();
    this.journalIds.length = 0;
  }
}
