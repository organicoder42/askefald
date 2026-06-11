/**
 * Input: keyboard state, accumulated mouse deltas, pointer lock.
 * Game code polls pressed()/justPressed() and consumeMouseDelta() each frame;
 * UI toggles can subscribe with onKey().
 */
export class Input {
  private keys = new Set<string>();
  private justPressedKeys = new Set<string>();
  private keyListeners = new Map<string, Array<() => void>>();
  private mouseDX = 0;
  private mouseDY = 0;
  pointerLocked = false;

  constructor(private domElement: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.justPressedKeys.add(e.code);
      const listeners = this.keyListeners.get(e.code);
      if (listeners) for (const fn of listeners) fn();
      // Keep browser shortcuts from stealing game keys while locked.
      if (this.pointerLocked && ['Tab', 'F3'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    domElement.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    domElement.addEventListener('click', () => {
      if (!this.pointerLocked) this.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.domElement;
    });
  }

  requestPointerLock(): void {
    this.domElement.requestPointerLock();
  }

  pressed(code: string): boolean {
    return this.keys.has(code);
  }

  justPressed(code: string): boolean {
    return this.justPressedKeys.has(code);
  }

  /** Subscribe to a key press (fires on keydown, even without pointer lock). */
  onKey(code: string, fn: () => void): void {
    const list = this.keyListeners.get(code) ?? [];
    list.push(fn);
    this.keyListeners.set(code, list);
  }

  /** Returns accumulated mouse movement since last call and resets it. */
  consumeMouseDelta(out: { x: number; y: number }): { x: number; y: number } {
    out.x = this.mouseDX;
    out.y = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return out;
  }

  /** Debug: hold a key down programmatically (headless walk tests). */
  debugHold(code: string): void {
    this.keys.add(code);
  }

  /** Call at the END of each frame to clear one-frame state. */
  endFrame(): void {
    this.justPressedKeys.clear();
  }
}
