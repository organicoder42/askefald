import * as THREE from 'three';
import type { SkyConfig } from './palette';

/**
 * Custom overcast sky dome (§6.3): gradient zenith→horizon, faint pale sun
 * disc with mie-style glow, very slow scrolling cloud noise. Also bakes the
 * procedural IBL environment via PMREMGenerator (§6.2).
 *
 * CONTRACT (workflow agents code against this — keep signatures exact):
 * - `mesh` is a large inverted sphere; frustumCulled=false; drawn first
 *   (renderOrder very low); depthWrite=false. Caller adds it to the scene.
 * - `applyConfig(sky, sunDir)`: sunDir is the direction of light TRAVEL
 *   (from sun toward scene, see palette.getSunDirection). The visible disc
 *   sits at -sunDir.
 * - `buildEnvironment(renderer)`: renders the CURRENT sky into a PMREM and
 *   returns the env texture. Caller assigns scene.environment and disposes
 *   any previous one. Called per act change, never per frame.
 * - `update(dt, elapsed)`: advances cloud scroll time only.
 */

const SKY_RADIUS = 850;
// Smaller dedicated dome for the PMREM bake so the cube camera's near/far
// fit comfortably (PMREM renders from the origin).
const BAKE_RADIUS = 100;

const VERTEX_GLSL = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// Outputs HDR-ish linear values (>1 near the sun); tone mapping + output
// colour-space conversion happen via the standard chunks (no-ops when the
// downstream post stack disables renderer tone mapping).
const FRAGMENT_GLSL = /* glsl */ `
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uGroundColor;
uniform vec3 uSunDiscColor;
uniform vec3 uSunDir;        // light TRAVEL direction; the disc sits at -uSunDir
uniform float uDiscCosOuter; // cos(discRadius)
uniform float uDiscCosInner; // cos(discRadius * 0.7)
uniform float uSunGlow;
uniform float uCloudAmount;
uniform float uCloudScale;
uniform float uTime;
varying vec3 vWorldPos;

float skyHash( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
}
float skyNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( skyHash( i ),                   skyHash( i + vec2( 1.0, 0.0 ) ), f.x ),
    mix( skyHash( i + vec2( 0.0, 1.0 ) ), skyHash( i + vec2( 1.0, 1.0 ) ), f.x ),
    f.y );
}
// 3-octave value noise, normalised to ~0..1.
float skyFbm( vec2 p ) {
  float n = 0.0;
  float amp = 0.5;
  for ( int i = 0; i < 3; i++ ) {
    n += amp * skyNoise( p );
    p = p * 2.17 + vec2( 19.7, -7.3 );
    amp *= 0.5;
  }
  return n * ( 1.0 / 0.875 );
}

void main() {
  vec3 dir = normalize( vWorldPos - cameraPosition );
  float h = dir.y;

  // (a) vertical gradient, blending to ground colour in a soft horizon band
  float up = pow( clamp( h, 0.0, 1.0 ), 1.6 );
  vec3 col = mix( uHorizonColor, uZenithColor, up );
  float groundBand = smoothstep( 0.02, -0.10, h );
  col = mix( col, uGroundColor, groundBand );

  // (d) overcast cloud noise: plane projection of the view ray, scrolling
  // very slowly (one drift cycle ~ minutes); luminance ±12% * cloudAmount,
  // darkening toward zenith for heavy overcast. Faded out at the horizon.
  vec2 cp = dir.xz / max( dir.y, 0.08 ) * ( uCloudScale * 0.55 );
  cp += vec2( uTime * 0.006, uTime * 0.0023 );
  float cn = skyFbm( cp ) * 2.0 - 1.0; // -1..1
  float aboveHorizon = smoothstep( 0.0, 0.08, h );
  float cloudMod = 1.0 + cn * 0.12 * uCloudAmount * aboveHorizon;
  cloudMod *= 1.0 - 0.16 * uCloudAmount * up;
  col *= cloudMod;

  // (c) mie-style glow: tight forward lobe (exponent 256→64 as glow rises)
  // plus a broad haze term — both modest, this is overcast.
  float sunDot = dot( dir, -uSunDir );
  float glowExp = mix( 256.0, 64.0, clamp( uSunGlow, 0.0, 1.0 ) );
  float glow = pow( max( sunDot, 0.0 ), glowExp );
  float haze = pow( max( sunDot, 0.0 ), 8.0 );
  // Tight lobe carries the glow; the broad haze stays faint or it swamps
  // the disc entirely and reads as a washed-out bright sky region.
  col += uSunDiscColor * ( glow * 0.5 + haze * 0.05 ) * uSunGlow;

  // (b) pale sun disc — lookable but unmistakable: ~3.4x sky luminance,
  // lightly veiled by the cloud noise so it breathes.
  float disc = smoothstep( uDiscCosOuter, uDiscCosInner, sunDot );
  float veil = 1.0 - 0.15 * uCloudAmount * clamp( cn * 0.5 + 0.5, 0.0, 1.0 );
  col = mix( col, uSunDiscColor * 3.4 * veil, disc );

  // (e) hash dithering to kill gradient banding
  float dn = skyHash( mod( gl_FragCoord.xy, 1024.0 ) );
  col += ( dn - 0.5 ) * ( 1.5 / 255.0 );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SkySystem {
  readonly mesh: THREE.Mesh;

  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.SphereGeometry;

  constructor() {
    this.geometry = new THREE.SphereGeometry(SKY_RADIUS, 48, 24);
    this.material = new THREE.ShaderMaterial({
      name: 'askefaldSky',
      uniforms: {
        uZenithColor: { value: new THREE.Color('#4a565f') },
        uHorizonColor: { value: new THREE.Color('#88909a') },
        uGroundColor: { value: new THREE.Color('#5c6166') },
        uSunDiscColor: { value: new THREE.Color('#f2ead8') },
        uSunDir: { value: new THREE.Vector3(0, -1, 0) },
        uDiscCosOuter: { value: Math.cos(0.038) },
        uDiscCosInner: { value: Math.cos(0.038 * 0.7) },
        uSunGlow: { value: 0.5 },
        uCloudAmount: { value: 0.75 },
        uCloudScale: { value: 1.0 },
        uTime: { value: 0 },
      },
      vertexShader: VERTEX_GLSL,
      fragmentShader: FRAGMENT_GLSL,
      side: THREE.BackSide,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'skyDome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  applyConfig(sky: SkyConfig, sunDir: THREE.Vector3): void {
    const u = this.material.uniforms;
    (u.uZenithColor.value as THREE.Color).set(sky.zenithColor);
    (u.uHorizonColor.value as THREE.Color).set(sky.horizonColor);
    (u.uGroundColor.value as THREE.Color).set(sky.groundColor);
    (u.uSunDiscColor.value as THREE.Color).set(sky.sunDiscColor);
    (u.uSunDir.value as THREE.Vector3).copy(sunDir).normalize();
    u.uDiscCosOuter.value = Math.cos(sky.sunDiscSize);
    u.uDiscCosInner.value = Math.cos(sky.sunDiscSize * 0.55);
    u.uSunGlow.value = sky.sunGlow;
    u.uCloudAmount.value = sky.cloudAmount;
    u.uCloudScale.value = sky.cloudScale;
  }

  update(dt: number, _elapsed: number): void {
    (this.material.uniforms.uTime as { value: number }).value += dt;
  }

  /**
   * Bake the current sky into a PMREM environment texture. Uses a small
   * dedicated dome sharing THE SAME material so the bake always matches the
   * visible sky. PMREMGenerator disables tone mapping internally, so the
   * result is linear HDR. Callable repeatedly (act changes, GUI re-bake);
   * the caller assigns scene.environment and disposes the previous texture —
   * the PMREM render target frees itself when that texture is disposed.
   */
  buildEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
    const bakeGeometry = new THREE.SphereGeometry(BAKE_RADIUS, 32, 16);
    const bakeMesh = new THREE.Mesh(bakeGeometry, this.material);
    bakeMesh.frustumCulled = false;
    const bakeScene = new THREE.Scene();
    bakeScene.add(bakeMesh);

    const pmrem = new THREE.PMREMGenerator(renderer);
    // fromScene(scene, sigma, near, far) — verified against @types/three r184.
    const rt = pmrem.fromScene(bakeScene, 0.04, 1, BAKE_RADIUS * 1.5);
    pmrem.dispose();

    bakeScene.remove(bakeMesh);
    bakeGeometry.dispose(); // material is shared with the live dome — keep it

    const texture = rt.texture;
    // RenderTarget.dispose() only dispatches its dispose event (verified in
    // three r184 source) — no recursion back into texture.dispose().
    texture.addEventListener('dispose', () => rt.dispose());
    return texture;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
