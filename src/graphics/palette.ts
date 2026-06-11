import * as THREE from 'three';

/**
 * Palette tokens (§5.1) and per-act look configuration (§5.2, §6).
 * Every LUT, fog colour, light colour and material tint derives from these.
 * Chroma is rationed: acts I–III stay near greyscale except act accents;
 * `spire` green appears ONLY in the epilogue.
 */
export const PALETTE = {
  aske: '#9A9C9B',
  novemberblaa: '#5C6B7A',
  baal: '#E8A23C',
  kridt: '#E9E7DF',
  natrium: '#D9A441',
  spire: '#7FA86B',
} as const;

export type ActId = 'act1' | 'act2' | 'act3' | 'epilogue';

export interface SunConfig {
  /** Degrees above horizon. */
  elevationDeg: number;
  /** Degrees around Y; 0 = sun toward -Z (down the street). */
  azimuthDeg: number;
  intensity: number;
  color: string;
}

export interface FogConfig {
  color: string;
  /** FogExp2-style density for the distance term. */
  density: number;
  /** Height-fog: density multiplier at heightOffset. */
  heightDensity: number;
  /** Height-fog exponential falloff per metre above heightOffset. */
  heightFalloff: number;
  /** World Y of the fog "sea level". */
  heightOffset: number;
  /** 0..1 noise modulation of fog amount. */
  noiseAmount: number;
}

export interface SkyConfig {
  zenithColor: string;
  horizonColor: string;
  groundColor: string;
  sunDiscColor: string;
  /** Angular radius of the visible pale sun disc, radians. */
  sunDiscSize: number;
  /** Strength of the mie-style glow around the disc, 0..1. */
  sunGlow: number;
  /** 0..1 overcast cloud-noise visibility. */
  cloudAmount: number;
  cloudScale: number;
}

export interface AshConfig {
  /** Global settled-ash level 0..1, drives the ash-settle shader. */
  level: number;
  /** Particles per baseline volume (before quality multiplier). */
  count: number;
  fallSpeed: number;
  wind: [number, number, number];
  /** 0..1, storms raise this at runtime. */
  storm: number;
}

export interface GradeConfig {
  /** Linear RGB multipliers applied in the LUT around mid-grey. */
  shadowTint: string;
  highlightTint: string;
  saturation: number;
  contrast: number;
  /** -1 cold .. +1 warm. */
  temperature: number;
}

export interface ActLookConfig {
  id: ActId;
  exposure: number;
  sun: SunConfig;
  hemi: { skyColor: string; groundColor: string; intensity: number };
  fog: FogConfig;
  sky: SkyConfig;
  ash: AshConfig;
  grade: GradeConfig;
}

export const ACT_CONFIGS: Record<ActId, ActLookConfig> = {
  // Act I — BYEN. Blue-grey twilight at noon; the askesol a pale disc at 8°.
  act1: {
    id: 'act1',
    exposure: 0.92,
    // Elevation/azimuth frame the disc just above the street's vanishing
    // point from the spawn camera (roofline sits at ~7° from eye height).
    sun: { elevationDeg: 10, azimuthDeg: 8, intensity: 2.8, color: '#d8dde2' },
    // Overcast daylight is ambient-dominated: the hemisphere carries the
    // scene, the low sun only rims and casts the long soft shadows.
    hemi: { skyColor: '#5C6B7A', groundColor: '#3b4046', intensity: 1.5 },
    fog: {
      color: '#67727d',
      density: 0.0046,
      heightDensity: 0.16,
      heightFalloff: 0.11,
      heightOffset: 0,
      noiseAmount: 0.3,
    },
    sky: {
      zenithColor: '#4a565f',
      horizonColor: '#88909a',
      groundColor: '#5c6166',
      sunDiscColor: '#f2ead8',
      sunDiscSize: 0.038,
      sunGlow: 0.65,
      cloudAmount: 0.75,
      cloudScale: 1.0,
    },
    ash: { level: 0.62, count: 40000, fallSpeed: 0.55, wind: [-0.5, 0, 0.15], storm: 0 },
    grade: {
      shadowTint: '#5C6B7A',
      highlightTint: '#d9dde0',
      saturation: 0.82,
      contrast: 1.06,
      temperature: -0.25,
    },
  },
  // Act II — LEJREN. Amber lamplight against blue dusk.
  act2: {
    id: 'act2',
    exposure: 1.0,
    sun: { elevationDeg: 3, azimuthDeg: -30, intensity: 0.9, color: '#aeb6bf' },
    hemi: { skyColor: '#46535f', groundColor: '#33373c', intensity: 0.45 },
    fog: {
      color: '#5d6770',
      density: 0.009,
      heightDensity: 0.5,
      heightFalloff: 0.13,
      heightOffset: 0,
      noiseAmount: 0.35,
    },
    sky: {
      zenithColor: '#39434c',
      horizonColor: '#6f7780',
      groundColor: '#4a4e53',
      sunDiscColor: '#e8d9c2',
      sunDiscSize: 0.034,
      sunGlow: 0.35,
      cloudAmount: 0.8,
      cloudScale: 1.1,
    },
    ash: { level: 0.7, count: 40000, fallSpeed: 0.5, wind: [-0.7, 0, 0.3], storm: 0 },
    grade: {
      shadowTint: '#4d5a68',
      highlightTint: '#E8A23C',
      saturation: 0.9,
      contrast: 1.1,
      temperature: 0.1,
    },
  },
  // Act III — BUNKEREN. No sun; chalk bounce, sodium + fluorescent interiors.
  act3: {
    id: 'act3',
    exposure: 1.1,
    sun: { elevationDeg: 14, azimuthDeg: 40, intensity: 0.0, color: '#cfd4d8' },
    hemi: { skyColor: '#7d858c', groundColor: '#5a5e62', intensity: 0.65 },
    fog: {
      color: '#84898e',
      density: 0.005,
      heightDensity: 0.25,
      heightFalloff: 0.1,
      heightOffset: 0,
      noiseAmount: 0.2,
    },
    sky: {
      zenithColor: '#666e75',
      horizonColor: '#9aa0a5',
      groundColor: '#6e7276',
      sunDiscColor: '#efe9dc',
      sunDiscSize: 0.03,
      sunGlow: 0.25,
      cloudAmount: 0.85,
      cloudScale: 1.2,
    },
    ash: { level: 0.45, count: 25000, fallSpeed: 0.45, wind: [0.4, 0, -0.2], storm: 0 },
    grade: {
      shadowTint: '#6b7176',
      highlightTint: '#E9E7DF',
      saturation: 0.9,
      contrast: 1.04,
      temperature: 0,
    },
  },
  // Epilogue — DET FØRSTE LYS. The only full-colour, real-sun scene.
  epilogue: {
    id: 'epilogue',
    exposure: 1.25,
    sun: { elevationDeg: 16, azimuthDeg: -25, intensity: 3.6, color: '#ffe3b8' },
    hemi: { skyColor: '#9db4c4', groundColor: '#6f6a5e', intensity: 0.6 },
    fog: {
      color: '#b6bdc2',
      density: 0.0028,
      heightDensity: 0.12,
      heightFalloff: 0.09,
      heightOffset: 0,
      noiseAmount: 0.15,
    },
    sky: {
      zenithColor: '#7ba0bd',
      horizonColor: '#e7d9c4',
      groundColor: '#8a8377',
      sunDiscColor: '#fff1d6',
      sunDiscSize: 0.042,
      sunGlow: 0.8,
      cloudAmount: 0.45,
      cloudScale: 0.9,
    },
    ash: { level: 0.25, count: 8000, fallSpeed: 0.3, wind: [0.2, 0, 0.1], storm: 0 },
    grade: {
      shadowTint: '#7d7a72',
      highlightTint: '#ffe9c4',
      saturation: 1.12,
      contrast: 1.05,
      temperature: 0.35,
    },
  },
};

/**
 * Direction of light TRAVEL (from sun toward the scene), unit length.
 * DirectionalLight.position should be set to `origin - dir * distance`;
 * the sky places its disc at `-dir`.
 */
export function getSunDirection(sun: SunConfig, out = new THREE.Vector3()): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(sun.elevationDeg);
  const az = THREE.MathUtils.degToRad(sun.azimuthDeg);
  // Sun sits toward -Z at azimuth 0, elevated by `el`; light travels opposite.
  out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  out.negate();
  return out.normalize();
}
