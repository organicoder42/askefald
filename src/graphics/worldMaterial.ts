import * as THREE from 'three';
import { PALETTE } from './palette';

/**
 * The game's visual signature (§6.3, §6.4): a single shared onBeforeCompile
 * injection applied to every world MeshStandardMaterial/MeshPhysicalMaterial.
 *
 * It adds two things, both driven by the shared `worldUniforms` below:
 *
 *  1. LAYERED FOG — an exp²-distance term plus an analytic height-fog term
 *     (exponential falloff above a world-height plane), modulated by slow
 *     3D value noise. Replaces three's own fog chunk; scene.fog stays null
 *     and all patched materials fog identically in linear HDR space.
 *
 *  2. ASH-SETTLE — albedo/roughness blend toward the ash colour as a
 *     function of world-space normal Y (up-facing surfaces collect ash),
 *     distance-stable world-space noise (so drifts have edges), the global
 *     `uAshLevel` (rises over each act, spikes after storms) and a
 *     per-material `ashAmount`.
 *
 * Usage:
 *   patchWorldMaterial(mat)                          // fog + ash, default amount 1
 *   patchWorldMaterial(mat, { ashAmount: 0 })        // fog only (e.g. vertical glass)
 *   patchWorldMaterial(mat, { ashAmount: 1.6 })      // extra-buried prop
 *
 * Per frame, the scene updates `worldUniforms.uTime` and act transitions
 * lerp the fog/ash uniform values. Uniform OBJECTS are shared by reference —
 * never replace `.value` objects wholesale for Color/Vector3, mutate them.
 */
export const worldUniforms = {
  uTime: { value: 0 },
  // Fog
  uFogColor: { value: new THREE.Color('#737d87') },
  uFogDensity: { value: 0.0062 },
  uHeightFogDensity: { value: 0.35 },
  uHeightFogFalloff: { value: 0.11 },
  uHeightFogOffset: { value: 0.0 },
  uFogNoiseAmount: { value: 0.3 },
  // Ash
  uAshLevel: { value: 0.78 },
  // Slightly above the palette token: the blanket must read as pale powder
  // against asphalt, and lighting always lands it a touch darker on screen.
  uAshColor: { value: new THREE.Color('#a6a8a5') },
  uAshNoiseScale: { value: 0.55 },
};

export interface WorldMaterialOptions {
  /** Per-material ash multiplier. 0 disables the ash chunk entirely. */
  ashAmount?: number;
  /** Skip the fog chunk (rare; e.g. sky-attached elements). */
  fog?: boolean;
}

export const ASK_NOISE_GLSL = /* glsl */ `
float askHash( vec3 p ) {
  p = fract( p * 0.3183099 + vec3( 0.1, 0.17, 0.13 ) );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float askNoise( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( askHash( i + vec3( 0, 0, 0 ) ), askHash( i + vec3( 1, 0, 0 ) ), f.x ),
         mix( askHash( i + vec3( 0, 1, 0 ) ), askHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( askHash( i + vec3( 0, 0, 1 ) ), askHash( i + vec3( 1, 0, 1 ) ), f.x ),
         mix( askHash( i + vec3( 0, 1, 1 ) ), askHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ),
    f.z );
}
`;

/**
 * The fog math, exported separately so non-patched shaders (ash particles,
 * sky-adjacent custom ShaderMaterials) can apply IDENTICAL fog.
 * Expects: worldPos (vec3), viewDist (float), the world uniforms, askNoise().
 * Returns fog mix factor 0..1.
 */
export const ASK_FOG_FACTOR_GLSL = /* glsl */ `
float askFogFactor( vec3 worldPos, float viewDist, vec3 camPos, float time ) {
  // Distance term (FogExp2)
  float f1 = 1.0 - exp( - uFogDensity * uFogDensity * viewDist * viewDist );
  // Analytic height-fog integral along the view ray
  vec3 rd = ( worldPos - camPos ) / max( viewDist, 1e-4 );
  float b = uHeightFogFalloff;
  float c = uHeightFogDensity * exp( -( camPos.y - uHeightFogOffset ) * b );
  float denom = rd.y * b;
  float integ = abs( denom ) > 1e-4 ? ( 1.0 - exp( - viewDist * denom ) ) / denom : viewDist;
  float f2 = 1.0 - exp( - max( c * integ * 0.06, 0.0 ) );
  // Combine + slow drifting noise so the fog breathes
  float fogF = clamp( 1.0 - ( 1.0 - f1 ) * ( 1.0 - f2 ), 0.0, 1.0 );
  float n = askNoise( worldPos * 0.035 + vec3( time * 0.02, 0.0, time * 0.013 ) );
  fogF *= 1.0 - uFogNoiseAmount * 0.5 + uFogNoiseAmount * n;
  return clamp( fogF, 0.0, 0.985 );
}
`;

const FOG_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uHeightFogDensity;
uniform float uHeightFogFalloff;
uniform float uHeightFogOffset;
uniform float uFogNoiseAmount;
uniform float uTime;
`;

type PatchableMaterial = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial | THREE.MeshLambertMaterial;

/**
 * Patch a world material with shared fog + ash-settle shader chunks.
 * Safe for InstancedMesh and skinned meshes (world position derived from
 * `transformed` with instanceMatrix applied; world normal recovered from the
 * view-space normal via the viewMatrix-transpose trick).
 */
export function patchWorldMaterial(mat: PatchableMaterial, opts: WorldMaterialOptions = {}): void {
  const ashAmount = opts.ashAmount ?? 1.0;
  const useAsh = ashAmount > 0;
  const useFog = opts.fog !== false;
  const ashAmountUniform = { value: ashAmount };

  // Expose for runtime tweaks (debug GUI, scripted burial).
  (mat.userData as Record<string, unknown>).ashAmountUniform = ashAmountUniform;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, worldUniforms, { uAshAmount: ashAmountUniform });

    // ---- vertex: world position + world normal varyings ----
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
varying vec3 vAskWorldPos;
varying vec3 vAskNormal;
varying vec3 vAskViewPos;`,
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
{
  vec4 askWp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    askWp = instanceMatrix * askWp;
  #endif
  askWp = modelMatrix * askWp;
  vAskWorldPos = askWp.xyz;
  vAskViewPos = mvPosition.xyz;
  // view-space normal -> world space: world = transpose(viewRot) * viewN
  vAskNormal = normalize( ( vec4( transformedNormal, 0.0 ) * viewMatrix ).xyz );
}`,
      );

    // ---- fragment: declarations ----
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      /* glsl */ `#include <common>
varying vec3 vAskWorldPos;
varying vec3 vAskNormal;
varying vec3 vAskViewPos;
${FOG_UNIFORMS_GLSL}
uniform float uAshLevel;
uniform float uAshAmount;
uniform vec3 uAshColor;
uniform float uAshNoiseScale;
${ASK_NOISE_GLSL}
${ASK_FOG_FACTOR_GLSL}`,
    );

    // ---- fragment: ash-settle, before lighting (after roughness resolves) ----
    if (useAsh) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
{
  float askUp = clamp( vAskNormal.y, 0.0, 1.0 );
  float askN = askNoise( vAskWorldPos * uAshNoiseScale );
  float askN2 = askNoise( vAskWorldPos * uAshNoiseScale * 6.7 + 13.1 );
  float askCover = clamp( uAshLevel * uAshAmount, 0.0, 1.5 );
  // Drift edges: noise pushes the threshold so ash pools with borders,
  // not as a uniform wash. More cover -> lower threshold -> wider blanket.
  float askSignal = askUp + ( askN - 0.5 ) * 0.6 + ( askN2 - 0.5 ) * 0.2;
  float askThr = 1.05 - askCover * 0.62;
  float askEdge = smoothstep( askThr - 0.18, askThr + 0.12, askSignal );
  vec3 askTint = uAshColor * ( 0.88 + 0.24 * askN2 );
  diffuseColor.rgb = mix( diffuseColor.rgb, askTint, askEdge );
  roughnessFactor = mix( roughnessFactor, 0.96, askEdge );
}`,
      );
    }

    // ---- fragment: layered fog replaces three's fog chunk ----
    if (useFog) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        /* glsl */ `{
  float askDist = length( vAskViewPos );
  float askFogF = askFogFactor( vAskWorldPos, askDist, cameraPosition, uTime );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, uFogColor, askFogF );
}`,
      );
    }
  };

  // Distinct program variants per chunk combination.
  mat.customProgramCacheKey = () => `askefald|ash:${useAsh ? 1 : 0}|fog:${useFog ? 1 : 0}`;
}

/** Set the per-material ash multiplier after patching (scripted burial). */
export function setAshAmount(mat: THREE.Material, amount: number): void {
  const u = (mat.userData as Record<string, unknown>).ashAmountUniform as
    | { value: number }
    | undefined;
  if (u) u.value = amount;
}
