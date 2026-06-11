import * as THREE from 'three';
import { ASK_FOG_FACTOR_GLSL, ASK_NOISE_GLSL, worldUniforms } from './worldMaterial';

/**
 * Falling-ash GPU particle system (§6.3): tens of thousands of soft point
 * sprites in a camera-following wrap-around volume, curl-noise wind drift
 * in the vertex shader, per-particle size/rotation/seed, fogged with the
 * SAME fog math as world materials (import ASK_NOISE_GLSL /
 * ASK_FOG_FACTOR_GLSL / worldUniforms from worldMaterial.ts).
 *
 * Storm mode (setStorm 0..1) raises speed, adds horizontal shear and
 * stretches sprites into streaks. Runs in every exterior, always.
 *
 * CONTRACT:
 * - constructor allocates ALL buffers once; setDensity uses drawRange only.
 * - update() must not allocate.
 * - points.frustumCulled = false; volume follows the camera via uniform.
 */
export interface AshParticlesOptions {
  count: number;
  /** Edge length of the wrap-around box volume in metres. Default 70. */
  areaSize?: number;
}

type AshUniforms = typeof worldUniforms & {
  uCamPos: { value: THREE.Vector3 };
  uArea: { value: number };
  uFall: { value: number };
  uWind: { value: THREE.Vector3 };
  uStorm: { value: number };
  uPixelRatio: { value: number };
  uSizeScale: { value: number };
};

const VERTEX_GLSL = /* glsl */ `
attribute vec3 aSeed;
attribute vec4 aRand;

uniform float uTime;
uniform vec3 uCamPos;
uniform float uArea;
uniform float uFall;
uniform vec3 uWind;
uniform float uStorm;
uniform float uPixelRatio;
uniform float uSizeScale;

varying vec3 vWorldPos;
varying float vViewDist;
varying float vRot;
varying float vBright;

${ASK_NOISE_GLSL}

void main() {
  vec3 basePos = aSeed * uArea;

  // Unbounded drift integrates ONLY constant-rate terms (wind, fall). Storm
  // scales the fall rate multiplicatively; gusts go into the bounded sway
  // below, never into time-multiplied drift (would explode after minutes).
  float fallSpeed = uFall * ( 1.0 + uStorm * 2.5 ) * ( 0.7 + 0.6 * fract( aSeed.x * 7.13 ) );
  vec3 drift = vec3( uWind.x * uTime, -fallSpeed * uTime, uWind.z * uTime );

  // Wrap the volume around the camera (component-wise, always re-centred).
  vec3 wrapped = mod( basePos + drift - uCamPos, vec3( uArea ) ) - 0.5 * uArea;

  // Curl-ish sway + storm gusts: instantaneous, bounded offsets.
  vec3 sway = vec3( 0.0 );
  sway.x = sin( uTime * 0.8 + aRand.z * 6.2831 ) * ( 0.35 + uStorm * 1.2 );
  sway.z = cos( uTime * 0.67 + aRand.z * 4.7 ) * 0.3;
  float windLen = length( uWind.xz );
  vec2 windDir = windLen > 1e-4 ? uWind.xz / windLen : vec2( 1.0, 0.0 );
  float gust = askNoise( vec3( uTime * 0.55, aSeed.x * 23.7, aSeed.z * 17.3 ) ) - 0.5;
  sway.xz += windDir * uStorm * gust * 4.5;

  vec3 worldPos = uCamPos + wrapped + sway;

  vec4 mvPosition = viewMatrix * vec4( worldPos, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aRand.x * uSizeScale * uPixelRatio * ( 1.0 + uStorm * 0.8 )
    * clamp( 120.0 / -mvPosition.z, 0.05, 14.0 );

  vWorldPos = worldPos;
  vViewDist = length( mvPosition.xyz );
  // Tumbling spin; storms align flakes toward the fall axis so the
  // fragment-side ellipse squash reads as streaking, not pinwheels.
  float rot = aRand.y * 6.2831 + uTime * ( aRand.y - 0.5 ) * 2.6;
  vRot = mix( rot, ( aRand.y - 0.5 ) * 0.6, uStorm );
  vBright = aRand.w;
}
`;

const FRAGMENT_GLSL = /* glsl */ `
uniform vec3 uCamPos;
uniform float uStorm;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uHeightFogDensity;
uniform float uHeightFogFalloff;
uniform float uHeightFogOffset;
uniform float uFogNoiseAmount;
uniform float uTime;

varying vec3 vWorldPos;
varying float vViewDist;
varying float vRot;
varying float vBright;

${ASK_NOISE_GLSL}
${ASK_FOG_FACTOR_GLSL}

void main() {
  // Rotate the sprite footprint around its centre.
  vec2 pc = gl_PointCoord - 0.5;
  float cR = cos( vRot );
  float sR = sin( vRot );
  pc = mat2( cR, -sR, sR, cR ) * pc;

  // Storm: anisotropic squash — narrow across-wind, long along the fall
  // axis, so the soft falloff ellipse streaks.
  pc.x *= 1.0 + uStorm * 2.4;
  pc.y /= 1.0 + uStorm * 0.5;

  // One stable per-particle noise lookup: irregular flake silhouette.
  float irr = askNoise( vec3( pc * 6.0, vBright * 41.7 ) );
  float r = length( pc ) * ( 0.85 + 0.3 * irr );

  // Radial soft falloff: opaque core, feathered rim.
  float radial = smoothstep( 0.5, 0.15, r );

  // EXACTLY the world-material fog (shared uniforms + shared GLSL).
  float fogF = askFogFactor( vWorldPos, vViewDist, uCamPos, uTime );

  // Ash-grey, not snow-white — flakes must never outshine the sky behind.
  vec3 flake = vec3( 0.58, 0.59, 0.58 ) * vBright;
  vec3 color = mix( flake, uFogColor, fogF );

  // Dissolve into fog with distance; vanish right at the lens so flakes
  // never fill the screen.
  float alpha = 0.5 * radial * ( 1.0 - fogF );
  // Flakes dissolve before the fog wall does — visible streaks of falling
  // ash against fully fogged sky read as sprite overlays.
  alpha *= 1.0 - smoothstep( 40.0, 70.0, vViewDist );
  alpha *= smoothstep( 0.15, 0.8, vViewDist );
  if ( alpha < 0.004 ) discard;

  gl_FragColor = vec4( color, alpha );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class AshParticles {
  readonly points: THREE.Points;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly uniforms: AshUniforms;
  /** Allocated particle capacity; drawRange never exceeds it. */
  private readonly count: number;

  constructor(opts: AshParticlesOptions) {
    this.count = Math.max(1, Math.floor(opts.count));
    const area = opts.areaSize ?? 70;

    // ---- attributes, allocated once ----
    const seeds = new Float32Array(this.count * 3);
    const rand = new Float32Array(this.count * 4);
    for (let i = 0; i < this.count; i++) {
      seeds[i * 3 + 0] = Math.random();
      seeds[i * 3 + 1] = Math.random();
      seeds[i * 3 + 2] = Math.random();
      // Wide variance, biased small: a few big near-camera flakes against a
      // mass of fine dust reads as tumbling ash, not uniform snow.
      rand[i * 4 + 0] = 0.4 + Math.pow(Math.random(), 1.8) * 1.8; // size 0.4..2.2
      rand[i * 4 + 1] = Math.random(); // rotation phase
      rand[i * 4 + 2] = Math.random(); // sway phase
      rand[i * 4 + 3] = 0.8 + Math.random() * 0.4; // brightness 0.8..1.2
    }

    this.geometry = new THREE.BufferGeometry();
    const seedAttr = new THREE.BufferAttribute(seeds, 3);
    this.geometry.setAttribute('aSeed', seedAttr);
    // Alias the seed buffer as `position` (unused by the shader): the
    // renderer clamps drawRange against position.count, so density changes
    // via setDrawRange stay safe with zero extra memory.
    this.geometry.setAttribute('position', seedAttr);
    this.geometry.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
    this.geometry.setDrawRange(0, this.count);
    // frustumCulled is false; finite sphere guards any accidental re-enable.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), area);

    // ---- uniforms: shared world fog objects BY REFERENCE + our own ----
    this.uniforms = {
      ...worldUniforms,
      uCamPos: { value: new THREE.Vector3() },
      uArea: { value: area },
      uFall: { value: 0.55 },
      uWind: { value: new THREE.Vector3(-0.5, 0, 0.15) },
      uStorm: { value: 0 },
      uPixelRatio: {
        value: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio, 2) : 1,
      },
      uSizeScale: { value: 0.5 },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'AskefaldAshParticles',
      uniforms: this.uniforms,
      vertexShader: VERTEX_GLSL,
      fragmentShader: FRAGMENT_GLSL,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'askefald.ashParticles';
    this.points.frustumCulled = false;
    // World position is computed in-shader from uCamPos; the object itself
    // stays at the identity transform.
    this.points.matrixAutoUpdate = false;
  }

  update(_dt: number, elapsed: number, camera: THREE.Camera): void {
    // uTime is the shared worldUniforms object — same clock as world fog.
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
  }

  setStorm(v: number): void {
    this.uniforms.uStorm.value = THREE.MathUtils.clamp(v, 0, 1);
  }

  setWind(x: number, y: number, z: number): void {
    this.uniforms.uWind.value.set(x, y, z);
  }

  /** 0..1.5 multiplier on active particle count (drawRange; no realloc). */
  setDensity(multiplier: number): void {
    const active = Math.min(
      this.count,
      Math.floor(this.count * THREE.MathUtils.clamp(multiplier, 0, 1.5)),
    );
    this.geometry.setDrawRange(0, active);
  }

  /** Fall speed in m/s (ActLookConfig.ash.fallSpeed). */
  setFallSpeed(v: number): void {
    this.uniforms.uFall.value = Math.max(0, v);
  }

  /** Keep in sync with Engine.pixelRatio on resize/quality change. */
  setPixelRatio(v: number): void {
    this.uniforms.uPixelRatio.value = v;
  }

  /** Global flake size multiplier (look-dev GUI). Default 0.5. */
  setSizeScale(v: number): void {
    this.uniforms.uSizeScale.value = Math.max(0, v);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
