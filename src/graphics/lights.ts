import * as THREE from 'three';
import { getSunDirection, type ActLookConfig } from './palette';

/**
 * Sun + hemisphere rig (§6.2): one directional "askesol" with a tight,
 * player-following shadow frustum (~45 m ortho box, 4096 px PCFSoft,
 * normal-bias tuned against ash-shader acne), plus hemisphere fill.
 *
 * CONTRACT:
 * - `group` contains both lights + shadow target; caller adds to scene.
 * - `sunDir` always holds the current light-travel direction (unit).
 * - `followTarget(p)` re-centres the shadow box on p, snapped to the
 *   shadow-map texel grid to prevent edge shimmer. Call every frame.
 * - `applyConfig(cfg)` sets colors/intensities/direction from an act config.
 */

/** Half-extent of the ortho shadow frustum in metres. */
const SHADOW_EXTENT = 42;
/** Distance from the follow target back along -sunDir to the light. */
const SUN_DISTANCE = 180;

// followTarget scratch — zero per-frame allocations.
const _lightMat = new THREE.Matrix4();
const _lightMatInv = new THREE.Matrix4();
const _origin = new THREE.Vector3();
const _up = new THREE.Vector3();
const _snapped = new THREE.Vector3();

export class SunRig {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly group: THREE.Group;
  readonly sunDir = new THREE.Vector3(0, -1, 0);

  constructor(shadowMapSize = 4096) {
    this.group = new THREE.Group();
    this.group.name = 'sunRig';

    this.sun = new THREE.DirectionalLight('#d8dde2', 2.4);
    this.sun.name = 'askesol';
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);

    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = 1;
    cam.far = 400;
    cam.updateProjectionMatrix();

    // Tuned against ash-shader acne on flat ground with the sun grazing at
    // 8° elevation: the large normalBias pushes samples off the ash-blended
    // surface along the normal (cheap on flat streets), while the small
    // negative depth bias avoids peter-panning at facade bases. Exposed via
    // shadowBias/shadowNormalBias accessors for GUI tuning.
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.6;

    this.sun.position.copy(this.sunDir).multiplyScalar(-SUN_DISTANCE);
    this.sun.target.position.set(0, 0, 0);
    this.group.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight('#5C6B7A', '#3b4046', 0.55);
    this.hemi.name = 'hemiFill';
    this.group.add(this.hemi);
  }

  /** Shadow depth bias — public for GUI tuning (see constructor comment). */
  get shadowBias(): number {
    return this.sun.shadow.bias;
  }
  set shadowBias(v: number) {
    this.sun.shadow.bias = v;
  }

  /** Shadow normal bias — public for GUI tuning (see constructor comment). */
  get shadowNormalBias(): number {
    return this.sun.shadow.normalBias;
  }
  set shadowNormalBias(v: number) {
    this.sun.shadow.normalBias = v;
  }

  applyConfig(cfg: ActLookConfig): void {
    this.sun.color.set(cfg.sun.color);
    this.sun.intensity = cfg.sun.intensity;
    this.hemi.color.set(cfg.hemi.skyColor);
    this.hemi.groundColor.set(cfg.hemi.groundColor);
    this.hemi.intensity = cfg.hemi.intensity;

    // Direction OF TRAVEL (sun toward scene) — see palette.getSunDirection.
    getSunDirection(cfg.sun, this.sunDir);

    // Reposition the light around the current follow point with the new
    // direction (followTarget copies its argument before mutating anything).
    this.followTarget(this.sun.target.position);
  }

  /**
   * Re-centre sun position/target on `target`, snapped to the shadow-map
   * texel grid in light space so static shadow edges do not shimmer as the
   * player moves. Zero allocations.
   */
  followTarget(target: THREE.Vector3): void {
    const texel = (SHADOW_EXTENT * 2) / this.sun.shadow.mapSize.x;

    // Light-space basis looking down sunDir (guard near-vertical sun).
    _up.set(0, 1, 0);
    if (Math.abs(this.sunDir.y) > 0.98) _up.set(0, 0, 1);
    _lightMat.lookAt(_origin.set(0, 0, 0), this.sunDir, _up);
    _lightMatInv.copy(_lightMat).invert();

    _snapped.copy(target).applyMatrix4(_lightMatInv);
    _snapped.x = Math.round(_snapped.x / texel) * texel;
    _snapped.y = Math.round(_snapped.y / texel) * texel;
    _snapped.applyMatrix4(_lightMat);

    this.sun.target.position.copy(_snapped);
    this.sun.position.copy(_snapped).addScaledVector(this.sunDir, -SUN_DISTANCE);
  }

  setShadowMapSize(px: number): void {
    this.sun.shadow.mapSize.set(px, px);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null; // renderer re-allocates at the new size
    }
  }

  dispose(): void {
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.dispose();
    this.hemi.dispose();
  }
}
