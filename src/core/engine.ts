import * as THREE from 'three';

/**
 * Engine: owns the WebGLRenderer, the single requestAnimationFrame loop,
 * resize handling, and the per-frame update list.
 *
 * Rendering itself is pluggable: by default it calls renderer.render(),
 * but the post-processing stack (M1+) replaces that via setRenderFn().
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;

  /** Multiplied with min(devicePixelRatio, 2). Set from quality settings. */
  resolutionScale = 1;

  private clock = new THREE.Clock();
  private updateFns: Array<(dt: number, elapsed: number) => void> = [];
  private renderFn: ((dt: number) => void) | null = null;
  private resizeFns: Array<(width: number, height: number) => void> = [];
  private running = false;
  private elapsed = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.canvas = this.renderer.domElement;
    container.appendChild(this.canvas);

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1200);
    this.camera.position.set(0, 1.7, 0);

    this.applySize();
    window.addEventListener('resize', () => this.applySize());
  }

  /** Width/height in CSS pixels. */
  get size(): { width: number; height: number } {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  get pixelRatio(): number {
    return Math.min(window.devicePixelRatio, 2) * this.resolutionScale;
  }

  applySize(): void {
    const { width, height } = this.size;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    for (const fn of this.resizeFns) fn(width, height);
  }

  onUpdate(fn: (dt: number, elapsed: number) => void): void {
    this.updateFns.push(fn);
  }

  onResize(fn: (width: number, height: number) => void): void {
    this.resizeFns.push(fn);
  }

  /** Replace the default renderer.render() call (used by the post stack). */
  setRenderFn(fn: ((dt: number) => void) | null): void {
    this.renderFn = fn;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;
    for (const fn of this.updateFns) fn(dt, this.elapsed);
    if (this.renderFn) {
      this.renderFn(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
