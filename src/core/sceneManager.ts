import type { Engine } from './engine';
import type { QualitySettings } from './quality';

/**
 * Explicit scene state machine (§10.2). Each scene owns its full GPU
 * lifecycle: load() builds everything, dispose() must free it all — the
 * manager warns when a scene leaves children behind.
 *
 * M2 carries Lookdev + Act1City; the full chain
 * (Title → Act1 → RoadA → Act2 → CoastB → Act3 → Epilogue) lands with
 * the content milestones.
 */
export interface GameScene {
  readonly id: string;
  load(): void;
  update(dt: number, elapsed: number): void;
  /** Live quality switches (shadow map size, particle density, …). */
  applyQuality?(q: QualitySettings): void;
  dispose(): void;
}

export class SceneManager {
  private current: GameScene | null = null;
  private factories = new Map<string, () => GameScene>();

  constructor(private engine: Engine) {}

  register(id: string, factory: () => GameScene): void {
    this.factories.set(id, factory);
  }

  get currentId(): string | null {
    return this.current?.id ?? null;
  }

  switchTo(id: string): void {
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`unknown scene '${id}'`);
    if (this.current) {
      const prevId = this.current.id;
      this.current.dispose();
      this.current = null;
      // clear() only DETACHES — leftovers here mean the scene's dispose
      // missed objects whose GPU resources now leak for the session.
      if (this.engine.scene.children.length > 0) {
        console.warn(
          `SceneManager: scene '${prevId}' left ${this.engine.scene.children.length} object(s) behind`,
          this.engine.scene.children.map((c) => c.name || c.type),
        );
      }
    }
    this.engine.scene.clear();
    this.engine.scene.environment = null;
    const scene = factory();
    scene.load();
    this.current = scene;
  }

  update(dt: number, elapsed: number): void {
    this.current?.update(dt, elapsed);
  }

  applyQuality(q: QualitySettings): void {
    this.current?.applyQuality?.(q);
  }
}
