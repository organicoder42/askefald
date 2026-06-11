/**
 * Axis-aligned XZ trigger zones with enter/exit hysteresis (M3 housekeeping:
 * replaces act1_city's hardcoded flat-exposure one-off). Zones are cheap —
 * a handful of float compares per frame — and allocation-free.
 */
export interface RectZone {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface TriggerZoneOptions {
  /** Entering this rect fires onEnter. */
  enter: RectZone;
  /** Leaving this (usually slightly larger) rect fires onExit; defaults to `enter`. */
  exit?: RectZone;
  onEnter?: () => void;
  onExit?: () => void;
  /** Disarm after the first onEnter (one-shot story beats). */
  once?: boolean;
}

function contains(r: RectZone, x: number, z: number): boolean {
  return x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
}

export class TriggerZone {
  inside = false;
  private readonly enterRect: RectZone;
  private readonly exitRect: RectZone;
  private readonly onEnter?: () => void;
  private readonly onExit?: () => void;
  private readonly once: boolean;
  private done = false;

  constructor(opts: TriggerZoneOptions) {
    this.enterRect = opts.enter;
    this.exitRect = opts.exit ?? opts.enter;
    this.onEnter = opts.onEnter;
    this.onExit = opts.onExit;
    this.once = opts.once ?? false;
  }

  update(x: number, z: number): void {
    if (this.done) return;
    if (!this.inside) {
      if (contains(this.enterRect, x, z)) {
        this.inside = true;
        this.onEnter?.();
        if (this.once) this.done = true;
      }
    } else if (!contains(this.exitRect, x, z)) {
      this.inside = false;
      this.onExit?.();
    }
  }

  reset(): void {
    this.inside = false;
    this.done = false;
  }
}

/** A scene's zones, updated once per frame from the player position. */
export class TriggerSet {
  private readonly zones: TriggerZone[] = [];

  add(opts: TriggerZoneOptions): TriggerZone {
    const zone = new TriggerZone(opts);
    this.zones.push(zone);
    return zone;
  }

  update(x: number, z: number): void {
    for (const zone of this.zones) zone.update(x, z);
  }

  reset(): void {
    for (const zone of this.zones) zone.reset();
  }
}
