import { LookupTexture } from 'postprocessing';
import type { GradeConfig } from './palette';

/**
 * Per-act 3D LUTs (§6.8) generated in code from the palette tokens —
 * cold-teal Act I, amber-contrast Act II, clean-neutral Act III,
 * warm full-chroma epilogue. Applied AFTER tone mapping (display-referred).
 *
 * Grading model per texel (display-referred 0..1 RGB):
 *   temperature shift → saturation about Rec.709 luma → contrast about a
 *   0.435 pivot → split-toning toward shadowTint/highlightTint (≤ ~12%
 *   at the extremes, neutral at mid-grey).
 */

const cache = new WeakMap<GradeConfig, Map<number, LookupTexture>>();

/**
 * Tints must be display-referred sRGB here. THREE.Color(hex) converts into
 * the linear working space under default color management, so we parse the
 * hex ourselves and stay in display space end to end.
 */
function hexToRgb01(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function generateActLUT(grade: GradeConfig, size = 33): LookupTexture {
  let bySize = cache.get(grade);
  if (bySize) {
    const hit = bySize.get(size);
    if (hit) return hit;
  } else {
    bySize = new Map();
    cache.set(grade, bySize);
  }

  const lut = LookupTexture.createNeutral(size);
  const data = lut.image.data as Float32Array;
  const shadow = hexToRgb01(grade.shadowTint);
  const highlight = hexToRgb01(grade.highlightTint);
  const temp = grade.temperature;
  const pivot = 0.435;

  // Neutral LUT data is RGBA float; transform each texel in place.
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    r += temp * 0.04;
    b -= temp * 0.05;

    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = luma + (r - luma) * grade.saturation;
    g = luma + (g - luma) * grade.saturation;
    b = luma + (b - luma) * grade.saturation;

    r = pivot + (r - pivot) * grade.contrast;
    g = pivot + (g - pivot) * grade.contrast;
    b = pivot + (b - pivot) * grade.contrast;

    const sw = Math.pow(Math.max(0, 1 - luma), 2.2) * 0.1;
    const hw = Math.pow(Math.max(0, Math.min(1, luma)), 2.2) * 0.12;
    r += (shadow[0] - r) * sw + (highlight[0] - r) * hw;
    g += (shadow[1] - g) * sw + (highlight[1] - g) * hw;
    b += (shadow[2] - b) * sw + (highlight[2] - b) * hw;

    data[i] = Math.min(1, Math.max(0, r));
    data[i + 1] = Math.min(1, Math.max(0, g));
    data[i + 2] = Math.min(1, Math.max(0, b));
  }

  lut.needsUpdate = true;
  bySize.set(size, lut);
  return lut;
}
