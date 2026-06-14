import type * as THREE from 'three';
import type { Engine } from './engine';
import type { QualitySettings } from './quality';
import type { PlayerController } from '../actors/player';

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
  /** Player controller for playable scenes (valid after load()). */
  player?: PlayerController;
  /** Sun disc for god rays (valid after load()); glue hooks it on switch. */
  godRaysSource?: THREE.Mesh | null;
  load(): void;
  update(dt: number, elapsed: number): void;
  /** Player pressed the interact key (E) outside dialogue — pickups, doors. */
  interact?(): void;
  /** Live quality switches (shadow map size, particle density, …). */
  applyQuality?(q: QualitySettings): void;
  dispose(): void;
}

export class SceneManager {
  private current: GameScene | null = null;
  private factories = new Map<string, () => GameScene>();
  private switchListeners: Array<(scene: GameScene | null) => void> = [];

  constructor(private engine: Engine) {}

  register(id: string, factory: () => GameScene): void {
    this.factories.set(id, factory);
  }

  get currentId(): string | null {
    return this.current?.id ?? null;
  }

  get currentScene(): GameScene | null {
    return this.current;
  }

  /**
   * Fired with null right before a scene is disposed and with the new scene
   * right after its load() — generic glue (god rays source, free-cam, HUD
   * visibility) lives in main.ts instead of per-scene wrappers.
   */
  onSwitch(fn: (scene: GameScene | null) => void): void {
    this.switchListeners.push(fn);
  }

  switchTo(id: string): void {
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`unknown scene '${id}'`);
    if (this.current) {
      const prevId = this.current.id;
      for (const fn of this.switchListeners) fn(null);
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
    for (const fn of this.switchListeners) fn(scene);
  }

  update(dt: number, elapsed: number): void {
    this.current?.update(dt, elapsed);
  }

  applyQuality(q: QualitySettings): void {
    this.current?.applyQuality?.(q);
  }
}
