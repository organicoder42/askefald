import * as THREE from 'three';

/**
 * Perf HUD (F3): fps, frame ms, draw calls, triangles, GPU resource counts.
 * Budgets (§6.9): ≤300 draw calls, ≤1.5M tris on High.
 */
export class PerfHud {
  private el: HTMLDivElement;
  private visible = false;
  private frames = 0;
  private accum = 0;
  private fps = 0;
  private ms = 0;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed',
      'top:8px',
      'left:8px',
      'z-index:1000',
      'background:rgba(10,12,14,0.78)',
      'color:#cfd4d8',
      'font:11px/1.5 ui-monospace,monospace',
      'padding:8px 10px',
      'border-radius:4px',
      'pointer-events:none',
      'white-space:pre',
      'display:none',
    ].join(';');
    document.body.appendChild(this.el);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  get isVisible(): boolean {
    return this.visible;
  }

  update(dt: number): void {
    this.frames++;
    this.accum += dt;
    if (this.accum >= 0.25) {
      this.fps = this.frames / this.accum;
      this.ms = (this.accum / this.frames) * 1000;
      this.frames = 0;
      this.accum = 0;
      if (this.visible) this.redraw();
    }
  }

  private redraw(): void {
    const info = this.renderer.info;
    const calls = info.render.calls;
    const tris = info.render.triangles;
    const callsWarn = calls > 300 ? ' !' : '';
    const trisWarn = tris > 1_500_000 ? ' !' : '';
    this.el.textContent = [
      `fps    ${this.fps.toFixed(0)}`,
      `ms     ${this.ms.toFixed(2)}`,
      `calls  ${calls}${callsWarn}`,
      `tris   ${(tris / 1000).toFixed(0)}k${trisWarn}`,
      `geom   ${info.memory.geometries}`,
      `tex    ${info.memory.textures}`,
      `progs  ${info.programs?.length ?? 0}`,
    ].join('\n');
  }
}
