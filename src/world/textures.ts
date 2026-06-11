import * as THREE from 'three';
import { mulberry32, type Rng } from '../core/math';

/**
 * Tier-B procedural texture library (§6.5): canvas-generated PBR sets,
 * authored as functions, cached. Albedo textures get SRGBColorSpace;
 * roughness/normal stay linear. All get anisotropy 8, repeat wrapping,
 * mipmaps. A registry allows full disposal.
 *
 * Normal maps are derived from the same height field as the albedo
 * (sobel filter), so bumps line up with the visible grain.
 *
 * Physical tile sizes (set mesh material .repeat accordingly):
 *   asphalt ≈ 6 m, sidewalk ≈ 2.4 m, plaster ≈ 4 m, brick ≈ 2 m,
 *   ash drift ≈ 3 m, painted metal ≈ 2 m.
 */
export interface PBRSet {
  map: THREE.Texture;
  roughnessMap?: THREE.Texture;
  normalMap?: THREE.Texture;
}

/** Wire a PBRSet onto a standard material (roughnessMap implies roughness 1). */
export function applyPBR(mat: THREE.MeshStandardMaterial, set: PBRSet): void {
  mat.map = set.map;
  if (set.roughnessMap) {
    mat.roughnessMap = set.roughnessMap;
    mat.roughness = 1.0;
  }
  if (set.normalMap) mat.normalMap = set.normalMap;
}

// ---------------------------------------------------------------------------
// Shared machinery: seeded RNG, tileable value-noise fBm, canvas helpers,
// sobel height→normal, registry + caches.
// ---------------------------------------------------------------------------

/** Stateless lattice hash → [0,1). Stable across wrap-duplicated draws. */
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Tileable 2D value noise: lattice wraps at integer periods px/py. */
function valueNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = x - xi;
  const ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const x0 = ((xi % px) + px) % px;
  const x1 = (x0 + 1) % px;
  const y0 = ((yi % py) + py) % py;
  const y1 = (y0 + 1) % py;
  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x1, y0, seed);
  const v01 = hash2(x0, y1, seed);
  const v11 = hash2(x1, y1, seed);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

/**
 * Precomputed tileable fBm field (res×res), values ~[0,1] centred on 0.5.
 * Octave frequencies double so integer base periods keep every octave tiling.
 * Low-frequency fields are computed at modest res and bilinearly sampled —
 * far cheaper than per-pixel fBm at 1024².
 */
function fbmField(res: number, px: number, py: number, octaves: number, seed: number, gain = 0.5): Float32Array {
  const f = new Float32Array(res * res);
  let totalAmp = 0;
  let amp = 1;
  for (let o = 0; o < octaves; o++) {
    totalAmp += amp;
    amp *= gain;
  }
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      let v = 0;
      let a = 1;
      let fx = px;
      let fy = py;
      let s = seed;
      for (let o = 0; o < octaves; o++) {
        v += a * valueNoise((x / res) * fx, (y / res) * fy, fx, fy, s);
        a *= gain;
        fx *= 2;
        fy *= 2;
        s = (Math.imul(s, 1664525) + 1013904223) | 0;
      }
      f[y * res + x] = v / totalAmp;
    }
  }
  return f;
}

/** Bilinear sample of an fbmField with wrap; u/v in tile space [0,1). */
function sampleTile(field: Float32Array, res: number, u: number, v: number): number {
  let x = (u - Math.floor(u)) * res;
  let y = (v - Math.floor(v)) * res;
  const x0 = x | 0;
  const y0 = y | 0;
  x -= x0;
  y -= y0;
  const x1 = (x0 + 1) % res;
  const y1 = (y0 + 1) % res;
  const a = field[y0 * res + x0] + (field[y0 * res + x1] - field[y0 * res + x0]) * x;
  const b = field[y1 * res + x0] + (field[y1 * res + x1] - field[y1 * res + x0]) * x;
  return a + (b - a) * y;
}

interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

function makeCanvas(width: number, height = width): Layer {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}

/** '#rgb'/'#rrggbb' → display-sRGB bytes (no three colour management). */
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const registry: THREE.Texture[] = [];
const pbrCache = new Map<string, PBRSet>();
const signCache = new Map<string, THREE.Texture>();

function finishTexture(tex: THREE.Texture, opts: { srgb?: boolean } = {}): THREE.Texture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (opts.srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  registry.push(tex);
  return tex;
}

function layerTexture(layer: Layer, srgb: boolean): THREE.Texture {
  return finishTexture(new THREE.CanvasTexture(layer.canvas), { srgb });
}

/**
 * Sobel height→normal. Wrapped sampling keeps the normal map tileable.
 * Output stays linear (never SRGB). Green follows three's OpenGL convention
 * under the default CanvasTexture flipY.
 */
function heightToNormal(heightLayer: Layer, strength: number): THREE.Texture {
  const w = heightLayer.canvas.width;
  const h = heightLayer.canvas.height;
  const src = heightLayer.ctx.getImageData(0, 0, w, h).data;
  const out = makeCanvas(w, h);
  const img = out.ctx.createImageData(w, h);
  const d = img.data;
  const H = (x: number, y: number) => src[((((y % h) + h) % h) * w + (((x % w) + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = H(x - 1, y - 1);
      const tc = H(x, y - 1);
      const tr = H(x + 1, y - 1);
      const ml = H(x - 1, y);
      const mr = H(x + 1, y);
      const bl = H(x - 1, y + 1);
      const bc = H(x, y + 1);
      const br = H(x + 1, y + 1);
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
      const nx = -gx * strength;
      const ny = gy * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y * w + x) * 4;
      d[i] = (nx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  out.ctx.putImageData(img, 0, 0);
  return layerTexture(out, false);
}

/** Random-walk polyline (cracks, scratches) as a flat [x0,y0,x1,y1,...]. */
function randomWalk(rng: Rng, x: number, y: number, angle: number, steps: number, stepLen: number, wobble: number): number[] {
  const pts: number[] = [x, y];
  let a = angle;
  for (let i = 0; i < steps; i++) {
    a += (rng() - 0.5) * wobble;
    x += Math.cos(a) * stepLen * (0.6 + rng() * 0.8);
    y += Math.sin(a) * stepLen * (0.6 + rng() * 0.8);
    pts.push(x, y);
  }
  return pts;
}

function strokePath(ctx: CanvasRenderingContext2D, pts: number[], style: string, width: number): void {
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.stroke();
}

/** Axis-aligned quad with jittered corners (patch repairs, chips). */
function jitteredQuad(rng: Rng, x: number, y: number, w: number, h: number, jitter: number): number[] {
  const j = () => (rng() - 0.5) * 2 * jitter;
  return [x + j(), y + j(), x + w + j(), y + j(), x + w + j(), y + h + j(), x + j(), y + h + j()];
}

function fillPoly(ctx: CanvasRenderingContext2D, pts: number[], style: string): void {
  ctx.fillStyle = style;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fill();
}

function greyStyle(v: number): string {
  const b = Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${b},${b},${b})`;
}

/** Multiplicative per-pixel grain over an already-drawn layer. */
function grainPass(layer: Layer, seed: number, amount: number): void {
  const w = layer.canvas.width;
  const h = layer.canvas.height;
  const img = layer.ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const g = 1 + (hash2(x, y, seed) - 0.5) * amount;
      const i = (y * w + x) * 4;
      d[i] *= g;
      d[i + 1] *= g;
      d[i + 2] *= g;
    }
  }
  layer.ctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

/** Worn asphalt with patch repairs, faint lane paint remnants, cracks. */
export function makeAsphalt(seed = 11): PBRSet {
  const key = `asphalt|${seed}`;
  const hit = pbrCache.get(key);
  if (hit) return hit;

  const size = 1024;
  const rng = mulberry32(seed);
  const blotchF = fbmField(256, 4, 4, 4, seed ^ 0x51ab);
  const fineF = fbmField(512, 40, 40, 3, seed ^ 0x9c2d);

  const albedo = makeCanvas(size);
  const rough = makeCanvas(size);
  const heightL = makeCanvas(size);
  const aImg = albedo.ctx.createImageData(size, size);
  const rImg = rough.ctx.createImageData(size, size);
  const hImg = heightL.ctx.createImageData(size, size);
  const aD = aImg.data;
  const rD = rImg.data;
  const hD = hImg.data;
  const base = hexToRgb('#2e3032');

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const blotch = sampleTile(blotchF, 256, u, v);
      const fine = sampleTile(fineF, 512, u, v);
      const speck = hash2(x, y, seed ^ 0x33f1);
      // ±8% large blotches, finer aggregate sparkle on top
      const lum = 1 + (blotch - 0.5) * 0.16 + (fine - 0.5) * 0.09 + (speck - 0.5) * 0.1;
      const i = (y * size + x) * 4;
      aD[i] = base[0] * lum;
      aD[i + 1] = base[1] * lum;
      aD[i + 2] = base[2] * lum;
      aD[i + 3] = 255;
      const rv = (0.88 + (fine - 0.5) * 0.06 + (speck - 0.5) * 0.04) * 255;
      rD[i] = rv;
      rD[i + 1] = rv;
      rD[i + 2] = rv;
      rD[i + 3] = 255;
      const hv = (0.5 + (blotch - 0.5) * 0.35 + (fine - 0.5) * 0.18 + (speck - 0.5) * 0.1) * 255;
      hD[i] = hv;
      hD[i + 1] = hv;
      hD[i + 2] = hv;
      hD[i + 3] = 255;
    }
  }
  albedo.ctx.putImageData(aImg, 0, 0);
  rough.ctx.putImageData(rImg, 0, 0);
  heightL.ctx.putImageData(hImg, 0, 0);

  // Patch repairs: large irregular rectangles, darker and smoother. Inset
  // from the edges so the tile boundary stays seam-free.
  const nPatches = 2 + Math.floor(rng() * 3);
  for (let p = 0; p < nPatches; p++) {
    const pw = 140 + rng() * 240;
    const ph = 120 + rng() * 220;
    const px = 60 + rng() * (size - pw - 120);
    const py = 60 + rng() * (size - ph - 120);
    const quad = jitteredQuad(rng, px, py, pw, ph, 14);
    fillPoly(albedo.ctx, quad, `rgba(14,15,17,${0.1 + rng() * 0.1})`);
    fillPoly(rough.ctx, quad, 'rgba(0,0,0,0.2)'); // fresher bitumen = smoother
    fillPoly(heightL.ctx, quad, 'rgba(255,255,255,0.06)');
    strokePath(heightL.ctx, [...quad, quad[0], quad[1]], 'rgba(0,0,0,0.3)', 3);
    strokePath(albedo.ctx, [...quad, quad[0], quad[1]], 'rgba(10,11,12,0.25)', 2);
  }

  // Hairline cracks: dark random walks etched into the height field.
  const nCracks = 4 + Math.floor(rng() * 4);
  for (let c = 0; c < nCracks; c++) {
    const pts = randomWalk(rng, 70 + rng() * (size - 140), 70 + rng() * (size - 140), rng() * Math.PI * 2, 24 + Math.floor(rng() * 40), 9, 1.1);
    strokePath(albedo.ctx, pts, 'rgba(16,17,18,0.55)', 1.4);
    strokePath(heightL.ctx, pts, 'rgba(0,0,0,0.5)', 2);
    if (rng() < 0.5) {
      const bi = 2 * (2 + Math.floor(rng() * (pts.length / 2 - 4)));
      const branch = randomWalk(rng, pts[bi], pts[bi + 1], rng() * Math.PI * 2, 8 + Math.floor(rng() * 14), 8, 1.3);
      strokePath(albedo.ctx, branch, 'rgba(16,17,18,0.45)', 1.1);
      strokePath(heightL.ctx, branch, 'rgba(0,0,0,0.4)', 1.6);
    }
  }

  // Worn lane-paint dashes down the tile centre, half-erased strip by strip.
  const paint = hexToRgb('#7a7a74');
  const xc = size * 0.5;
  const dashLen = 220;
  const gap = 290;
  for (let y0 = 50; y0 + dashLen < size; y0 += dashLen + gap) {
    for (let sy = 0; sy < dashLen; sy += 4) {
      const m = hash2(0, y0 + sy, seed ^ 0x77aa);
      if (m < 0.42) continue; // erosion gaps
      const a = 0.15 * (0.4 + 0.6 * hash2(1, y0 + sy, seed ^ 0x77aa));
      const wJit = 15 * (0.85 + 0.3 * hash2(2, y0 + sy, seed ^ 0x77aa));
      const xJit = (hash2(3, y0 + sy, seed ^ 0x77aa) - 0.5) * 3;
      albedo.ctx.fillStyle = `rgba(${paint[0]},${paint[1]},${paint[2]},${a})`;
      albedo.ctx.fillRect(xc - wJit / 2 + xJit, y0 + sy, wJit, 4);
      rough.ctx.fillStyle = 'rgba(0,0,0,0.1)';
      rough.ctx.fillRect(xc - wJit / 2 + xJit, y0 + sy, wJit, 4);
    }
  }

  const set: PBRSet = {
    map: layerTexture(albedo, true),
    roughnessMap: layerTexture(rough, false),
    normalMap: heightToNormal(heightL, 0.6),
  };
  pbrCache.set(key, set);
  return set;
}

/** Concrete paving slabs with joints (Copenhagen sidewalk). */
export function makeSidewalk(seed = 23): PBRSet {
  const key = `sidewalk|${seed}`;
  const hit = pbrCache.get(key);
  if (hit) return hit;

  const size = 512;
  const slabs = 4; // 4×4 of 60 cm slabs → 2.4 m tile
  const slabW = size / slabs;
  const rng = mulberry32(seed);
  const midF = fbmField(256, 9, 9, 3, seed ^ 0x42c7);

  const albedo = makeCanvas(size);
  const rough = makeCanvas(size);
  const heightL = makeCanvas(size);
  const aImg = albedo.ctx.createImageData(size, size);
  const rImg = rough.ctx.createImageData(size, size);
  const hImg = heightL.ctx.createImageData(size, size);
  const aD = aImg.data;
  const rD = rImg.data;
  const hD = hImg.data;
  const base = hexToRgb('#7c7f82');

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const sy = Math.floor(y / slabW);
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const sx = Math.floor(x / slabW);
      const slabJ = (hash2(sx, sy, seed ^ 0x1d2f) - 0.5) * 0.12; // ±6%
      const mid = sampleTile(midF, 256, u, v);
      const speck = hash2(x, y, seed ^ 0x6b91);
      const lum = 1 + slabJ + (mid - 0.5) * 0.08 + (speck - 0.5) * 0.09;
      const i = (y * size + x) * 4;
      aD[i] = base[0] * lum;
      aD[i + 1] = base[1] * lum;
      aD[i + 2] = base[2] * lum;
      aD[i + 3] = 255;
      const rv = (0.85 + slabJ * 0.3 + (speck - 0.5) * 0.05) * 255;
      rD[i] = rv;
      rD[i + 1] = rv;
      rD[i + 2] = rv;
      rD[i + 3] = 255;
      const hv = (0.55 + slabJ * 0.4 + (mid - 0.5) * 0.1 + (speck - 0.5) * 0.08) * 255;
      hD[i] = hv;
      hD[i + 1] = hv;
      hD[i + 2] = hv;
      hD[i + 3] = 255;
    }
  }
  albedo.ctx.putImageData(aImg, 0, 0);
  rough.ctx.putImageData(rImg, 0, 0);
  heightL.ctx.putImageData(hImg, 0, 0);

  // Joints. Border lines draw half on each side of the tile edge → seamless.
  for (let i = 0; i <= slabs; i++) {
    const p = i * slabW;
    for (const horizontal of [false, true]) {
      const pts = horizontal ? [0, p, size, p] : [p, 0, p, size];
      strokePath(albedo.ctx, pts, 'rgba(28,30,32,0.6)', 2.5);
      strokePath(heightL.ctx, pts, 'rgba(0,0,0,0.7)', 3);
      strokePath(rough.ctx, pts, 'rgba(255,255,255,0.15)', 3);
    }
  }

  // Corner chips + occasional slab crack.
  for (let sy = 0; sy < slabs; sy++) {
    for (let sx = 0; sx < slabs; sx++) {
      for (let corner = 0; corner < 4; corner++) {
        if (hash2(sx * 4 + corner, sy, seed ^ 0x5e11) > 0.18) continue;
        const cx = (sx + (corner & 1)) * slabW;
        const cy = (sy + (corner >> 1)) * slabW;
        const dirX = corner & 1 ? -1 : 1;
        const dirY = corner >> 1 ? -1 : 1;
        const s = 6 + rng() * 12;
        const pts = [cx, cy, cx + dirX * s * (0.7 + rng() * 0.6), cy + dirY * s * 0.3, cx + dirX * s * 0.3, cy + dirY * s * (0.7 + rng() * 0.6)];
        fillPoly(albedo.ctx, pts, 'rgba(40,42,44,0.35)');
        fillPoly(heightL.ctx, pts, 'rgba(0,0,0,0.4)');
      }
      if (hash2(sx, sy, seed ^ 0x7f23) < 0.13) {
        const edge = rng() < 0.5;
        const x0 = sx * slabW + (edge ? rng() * slabW : 0);
        const y0 = sy * slabW + (edge ? 0 : rng() * slabW);
        const pts = randomWalk(rng, x0, y0, edge ? Math.PI / 2 : 0, 10 + Math.floor(rng() * 8), slabW / 14, 1.0);
        strokePath(albedo.ctx, pts, 'rgba(25,26,28,0.5)', 1);
        strokePath(heightL.ctx, pts, 'rgba(0,0,0,0.45)', 1.5);
      }
    }
  }

  const set: PBRSet = {
    map: layerTexture(albedo, true),
    roughnessMap: layerTexture(rough, false),
    normalMap: heightToNormal(heightL, 0.8),
  };
  pbrCache.set(key, set);
  return set;
}

/** Weathered painted plaster façade, streaked grime under sills. */
export function makePlasterFacade(baseColor: string, seed = 37): PBRSet {
  const key = `plaster|${baseColor}|${seed}`;
  const hit = pbrCache.get(key);
  if (hit) return hit;

  const size = 1024;
  const rng = mulberry32(seed);
  const blotchF = fbmField(256, 5, 5, 4, seed ^ 0x8d31);
  const grainF = fbmField(512, 44, 44, 3, seed ^ 0x2e57);

  const albedo = makeCanvas(size);
  const rough = makeCanvas(size);
  const heightL = makeCanvas(size);
  const aImg = albedo.ctx.createImageData(size, size);
  const rImg = rough.ctx.createImageData(size, size);
  const hImg = heightL.ctx.createImageData(size, size);
  const aD = aImg.data;
  const rD = rImg.data;
  const hD = hImg.data;
  const base = hexToRgb(baseColor);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const blotch = sampleTile(blotchF, 256, u, v);
      const grain = sampleTile(grainF, 512, u, v);
      const speck = hash2(x, y, seed ^ 0xb3c9);
      // Blotch contrast stays low: at street distance high-contrast patches
      // read as camo noise, not weathering.
      const lum = 1 + (blotch - 0.5) * 0.05 + (grain - 0.5) * 0.05 + (speck - 0.5) * 0.04;
      const i = (y * size + x) * 4;
      aD[i] = base[0] * lum;
      aD[i + 1] = base[1] * lum;
      aD[i + 2] = base[2] * lum;
      aD[i + 3] = 255;
      const rv = (0.8 + (grain - 0.5) * 0.2) * 255; // ±0.1
      rD[i] = rv;
      rD[i + 1] = rv;
      rD[i + 2] = rv;
      rD[i + 3] = 255;
      const hv = (0.5 + (grain - 0.5) * 0.3 + (blotch - 0.5) * 0.18 + (speck - 0.5) * 0.06) * 255;
      hD[i] = hv;
      hD[i + 1] = hv;
      hD[i + 2] = hv;
      hD[i + 3] = 255;
    }
  }
  albedo.ctx.putImageData(aImg, 0, 0);
  rough.ctx.putImageData(rImg, 0, 0);
  heightL.ctx.putImageData(hImg, 0, 0);

  // Vertical grime streaks from random sill heights — rain-washed soot,
  // darkest just below the sill, fading out downward.
  const nStreaks = 10 + Math.floor(rng() * 9);
  for (let s = 0; s < nStreaks; s++) {
    const x0 = rng() * size;
    const yTop = rng() * size * 0.7;
    const len = 80 + rng() * 360;
    const w = 6 + rng() * 22;
    const a = 0.05 + rng() * 0.13;
    const g = albedo.ctx.createLinearGradient(0, yTop, 0, yTop + len);
    g.addColorStop(0, `rgba(24,27,29,${a})`);
    g.addColorStop(0.15, `rgba(24,27,29,${a * 0.85})`);
    g.addColorStop(1, 'rgba(24,27,29,0)');
    albedo.ctx.fillStyle = g;
    albedo.ctx.fillRect(x0 - w / 2, yTop, w, len);
    const gr = rough.ctx.createLinearGradient(0, yTop, 0, yTop + len);
    gr.addColorStop(0, 'rgba(255,255,255,0.09)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    rough.ctx.fillStyle = gr;
    rough.ctx.fillRect(x0 - w / 2, yTop, w, len);
    const gh = heightL.ctx.createLinearGradient(0, yTop, 0, yTop + len);
    gh.addColorStop(0, 'rgba(0,0,0,0.05)');
    gh.addColorStop(1, 'rgba(0,0,0,0)');
    heightL.ctx.fillStyle = gh;
    heightL.ctx.fillRect(x0 - w / 2, yTop, w, len);
  }

  // A couple of hairline plaster cracks (subtle).
  const nCracks = Math.floor(rng() * 3);
  for (let c = 0; c < nCracks; c++) {
    const pts = randomWalk(rng, 80 + rng() * (size - 160), 60 + rng() * (size - 200), Math.PI / 2 + (rng() - 0.5) * 0.8, 14 + Math.floor(rng() * 16), 9, 0.9);
    strokePath(albedo.ctx, pts, 'rgba(30,32,34,0.3)', 1);
    strokePath(heightL.ctx, pts, 'rgba(0,0,0,0.3)', 1.4);
  }

  // Soot wash toward the top of the tile. NOTE: the tile repeats every ~4 m,
  // so this must stay near-subliminal or it bands at every floor line.
  const soot = albedo.ctx.createLinearGradient(0, 0, 0, size);
  soot.addColorStop(0, 'rgba(18,20,22,0.06)');
  soot.addColorStop(0.45, 'rgba(18,20,22,0)');
  albedo.ctx.fillStyle = soot;
  albedo.ctx.fillRect(0, 0, size, size);

  // Splash-back darkening in the bottom 8%.
  const splash = albedo.ctx.createLinearGradient(0, size * 0.92, 0, size);
  splash.addColorStop(0, 'rgba(20,22,24,0)');
  splash.addColorStop(1, 'rgba(20,22,24,0.22)');
  albedo.ctx.fillStyle = splash;
  albedo.ctx.fillRect(0, size * 0.92, size, size * 0.08);

  const set: PBRSet = {
    map: layerTexture(albedo, true),
    roughnessMap: layerTexture(rough, false),
    normalMap: heightToNormal(heightL, 0.45),
  };
  pbrCache.set(key, set);
  return set;
}

/** Danish brick façade (running bond, mortar joints, soot wash). */
export function makeBrickFacade(baseColor: string, seed = 53): PBRSet {
  const key = `brick|${baseColor}|${seed}`;
  const hit = pbrCache.get(key);
  if (hit) return hit;

  const size = 1024;
  // 9 columns × 36 rows over a 2 m tile (spec ≈8.7; integer keeps the wrap
  // seamless — brick pitch reads ~22 cm, visually indistinguishable).
  const cols = 9;
  const rows = 36;
  const pitchX = size / cols;
  const pitchY = size / rows;
  const joint = 5;

  const albedo = makeCanvas(size);
  const rough = makeCanvas(size);
  const heightL = makeCanvas(size);
  const base = hexToRgb(baseColor);
  const mortar = hexToRgb('#6f6b66');

  albedo.ctx.fillStyle = `rgb(${mortar[0]},${mortar[1]},${mortar[2]})`;
  albedo.ctx.fillRect(0, 0, size, size);
  rough.ctx.fillStyle = greyStyle(0.93);
  rough.ctx.fillRect(0, 0, size, size);
  heightL.ctx.fillStyle = greyStyle(0.36);
  heightL.ctx.fillRect(0, 0, size, size);

  const bSeed = seed ^ 0x1c4f;
  for (let row = 0; row < rows; row++) {
    const off = (row % 2) * pitchX * 0.5;
    for (let col = -1; col < cols; col++) {
      // Wrap-stable identity so the duplicate of an edge-crossing brick
      // gets identical jitter on both sides of the seam.
      const cIdx = ((col % cols) + cols) % cols;
      const h0 = hash2(cIdx, row, bSeed);
      const h1 = hash2(cIdx, row, bSeed + 101);
      const h2 = hash2(cIdx, row, bSeed + 202);
      const x = col * pitchX + off + joint * 0.5;
      const y = row * pitchY + joint * 0.5;
      const bw = pitchX - joint;
      const bh = pitchY - joint;
      const clinker = h2 < 0.06; // over-fired, much darker
      let lum = 1 + (h0 - 0.5) * 0.14; // ±7%
      if (clinker) lum *= 0.55;
      const shift = (h1 - 0.5) * 12; // warm/cool per-brick hue wobble
      const rr = Math.round(base[0] * lum + shift);
      const gg = Math.round(base[1] * lum);
      const bb = Math.round(base[2] * lum - shift * 0.6);
      albedo.ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      albedo.ctx.fillRect(x, y, bw, bh);
      albedo.ctx.strokeStyle = 'rgba(20,18,16,0.12)';
      albedo.ctx.lineWidth = 2;
      albedo.ctx.strokeRect(x + 1, y + 1, bw - 2, bh - 2);
      heightL.ctx.fillStyle = greyStyle(0.7 + (h0 - 0.5) * 0.12 + (clinker ? 0.06 : 0));
      heightL.ctx.fillRect(x, y, bw, bh);
      rough.ctx.fillStyle = greyStyle(clinker ? 0.55 : 0.74 + (h1 - 0.5) * 0.1);
      rough.ctx.fillRect(x, y, bw, bh);
    }
  }

  // Fine grain over bricks and mortar alike.
  grainPass(albedo, seed ^ 0x3fd5, 0.09);
  grainPass(rough, seed ^ 0x5ad3, 0.05);
  grainPass(heightL, seed ^ 0x71b9, 0.06);

  // Soot wash, top → down. The tile repeats every 2 m — keep it faint or
  // the façade stripes at every other brick course block.
  const soot = albedo.ctx.createLinearGradient(0, 0, 0, size);
  soot.addColorStop(0, 'rgba(14,15,17,0.08)');
  soot.addColorStop(0.5, 'rgba(14,15,17,0.02)');
  soot.addColorStop(1, 'rgba(14,15,17,0)');
  albedo.ctx.fillStyle = soot;
  albedo.ctx.fillRect(0, 0, size, size);

  const set: PBRSet = {
    map: layerTexture(albedo, true),
    roughnessMap: layerTexture(rough, false),
    normalMap: heightToNormal(heightL, 0.9),
  };
  pbrCache.set(key, set);
  return set;
}

/** Fine settled-ash drift surface (for displaced drift meshes). */
export function makeAshDrift(seed = 5): PBRSet {
  const key = `ash|${seed}`;
  const hit = pbrCache.get(key);
  if (hit) return hit;

  const size = 512;
  const rng = mulberry32(seed);
  // Anisotropic wind ripples: few periods along x, many along y → ridges
  // elongated along the wind axis. Warped so the bands never read straight.
  const rippleF = fbmField(256, 3, 14, 3, seed ^ 0xa14b);
  const warpF = fbmField(128, 2, 2, 2, seed ^ 0x60d7);
  const softF = fbmField(256, 6, 6, 3, seed ^ 0x1f83);

  const albedo = makeCanvas(size);
  const rough = makeCanvas(size);
  const heightL = makeCanvas(size);
  const aImg = albedo.ctx.createImageData(size, size);
  const rImg = rough.ctx.createImageData(size, size);
  const hImg = heightL.ctx.createImageData(size, size);
  const aD = aImg.data;
  const rD = rImg.data;
  const hD = hImg.data;
  const base = hexToRgb('#9A9C9B');
  const cinder = hexToRgb('#6b645c');

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const warp = (sampleTile(warpF, 128, u, v) - 0.5) * 0.1;
      const ripple = sampleTile(rippleF, 256, u, v + warp);
      const soft = sampleTile(softF, 256, u, v);
      const grain = hash2(x, y, seed ^ 0xd2e5);
      // POWDER: very low contrast, everything soft
      let lum = 1 + (ripple - 0.5) * 0.05 + (soft - 0.5) * 0.04 + (grain - 0.5) * 0.035;
      let cr = base[0];
      let cg = base[1];
      let cb = base[2];
      if (hash2(x, y, seed ^ 0x9bb1) < 0.0015) {
        // tiny cinder fleck
        cr = cinder[0];
        cg = cinder[1];
        cb = cinder[2];
        lum = 0.85 + grain * 0.2;
      }
      const i = (y * size + x) * 4;
      aD[i] = cr * lum;
      aD[i + 1] = cg * lum;
      aD[i + 2] = cb * lum;
      aD[i + 3] = 255;
      const rv = (0.97 + (grain - 0.5) * 0.02) * 255;
      rD[i] = rv;
      rD[i + 1] = rv;
      rD[i + 2] = rv;
      rD[i + 3] = 255;
      const hv = (0.5 + (ripple - 0.5) * 0.42 + (soft - 0.5) * 0.12 + (grain - 0.5) * 0.05) * 255;
      hD[i] = hv;
      hD[i + 1] = hv;
      hD[i + 2] = hv;
      hD[i + 3] = 255;
    }
  }
  albedo.ctx.putImageData(aImg, 0, 0);
  rough.ctx.putImageData(rImg, 0, 0);
  heightL.ctx.putImageData(hImg, 0, 0);

  // A few slightly larger cinders, soft-edged.
  for (let i = 0; i < 36; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const r = 0.7 + rng() * 1.6;
    albedo.ctx.fillStyle = `rgba(${cinder[0]},${cinder[1]},${cinder[2]},${0.25 + rng() * 0.3})`;
    albedo.ctx.beginPath();
    albedo.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    albedo.ctx.fill();
  }

  const set: PBRSet = {
    map: layerTexture(albedo, true),
    roughnessMap: layerTexture(rough, false),
    normalMap: heightToNormal(heightL, 0.5),
  };
  pbrCache.set(key, set);
  return set;
}

/** Scuffed painted metal (cars, lamp posts, signs). */
export function makeMetalPainted(color: string, seed = 71): PBRSet {
  const key = `metal|${color}|${seed}`;
  const hit = pbrCache.get(key);
  if (hit) return hit;

  const size = 512;
  const rng = mulberry32(seed);
  const peelF = fbmField(256, 36, 36, 3, seed ^ 0x4e21);
  const grimeF = fbmField(256, 5, 5, 3, seed ^ 0x8b6d);

  const albedo = makeCanvas(size);
  const rough = makeCanvas(size);
  const heightL = makeCanvas(size);
  const aImg = albedo.ctx.createImageData(size, size);
  const rImg = rough.ctx.createImageData(size, size);
  const hImg = heightL.ctx.createImageData(size, size);
  const aD = aImg.data;
  const rD = rImg.data;
  const hD = hImg.data;

  // Mute the requested paint colour toward its own grey (Act I chroma ration).
  const raw = hexToRgb(color);
  const grey = raw[0] * 0.299 + raw[1] * 0.587 + raw[2] * 0.114;
  const base: [number, number, number] = [
    raw[0] + (grey - raw[0]) * 0.22,
    raw[1] + (grey - raw[1]) * 0.22,
    raw[2] + (grey - raw[2]) * 0.22,
  ];
  const rust = hexToRgb('#5a4538');

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const peel = sampleTile(peelF, 256, u, v);
      const grimeN = sampleTile(grimeF, 256, u, v);
      // grime accumulates toward the bottom of the tile (canvas bottom = v=0)
      const bottom = Math.max(0, (v - 0.45) / 0.55);
      const grime = bottom * bottom * (0.55 + 0.45 * grimeN);
      let lum = (1 + (peel - 0.5) * 0.05) * (1 - grime * 0.24);
      let cr = base[0];
      let cg = base[1];
      let cb = base[2];
      let rv = 0.45 + (peel - 0.5) * 0.06 + grime * 0.22;
      let hv = 0.5 + (peel - 0.5) * 0.26;
      // rust speckle, denser near the tile edges (panel seams/borders)
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y) / size;
      const p = 0.004 * Math.max(0, 1 - edge / 0.1);
      if (hash2(x, y, seed ^ 0xc7a3) < p) {
        const m = 0.4 + hash2(y, x, seed ^ 0x39d1) * 0.4;
        cr = cr + (rust[0] - cr) * m;
        cg = cg + (rust[1] - cg) * m;
        cb = cb + (rust[2] - cb) * m;
        rv += 0.3;
        hv -= 0.08;
        lum = 1;
      }
      const i = (y * size + x) * 4;
      aD[i] = cr * lum;
      aD[i + 1] = cg * lum;
      aD[i + 2] = cb * lum;
      aD[i + 3] = 255;
      const rb = rv * 255;
      rD[i] = rb;
      rD[i + 1] = rb;
      rD[i + 2] = rb;
      rD[i + 3] = 255;
      const hb = hv * 255;
      hD[i] = hb;
      hD[i + 1] = hb;
      hD[i + 2] = hb;
      hD[i + 3] = 255;
    }
  }
  albedo.ctx.putImageData(aImg, 0, 0);
  rough.ctx.putImageData(rImg, 0, 0);
  heightL.ctx.putImageData(hImg, 0, 0);

  // Scratches: thin lighter strokes where the top coat is worn through.
  const nScratch = 9 + Math.floor(rng() * 8);
  for (let s = 0; s < nScratch; s++) {
    const pts = randomWalk(rng, 20 + rng() * (size - 40), 20 + rng() * (size - 40), rng() * Math.PI * 2, 4 + Math.floor(rng() * 10), 10, 0.35);
    const a = 0.2 + rng() * 0.25;
    strokePath(albedo.ctx, pts, `rgba(205,207,210,${a})`, 0.8);
    strokePath(rough.ctx, pts, 'rgba(255,255,255,0.3)', 1.2);
    strokePath(heightL.ctx, pts, 'rgba(0,0,0,0.35)', 1);
  }

  // A few rust blooms hugging the edges.
  for (let i = 0; i < 22; i++) {
    const side = Math.floor(rng() * 4);
    const t = rng() * size;
    const d = rng() * 18;
    const cx = side === 0 ? d : side === 1 ? size - d : t;
    const cy = side < 2 ? t : side === 2 ? d : size - d;
    const r = 1 + rng() * 2.6;
    albedo.ctx.fillStyle = `rgba(${rust[0]},${rust[1]},${rust[2]},${0.15 + rng() * 0.25})`;
    albedo.ctx.beginPath();
    albedo.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    albedo.ctx.fill();
    rough.ctx.fillStyle = 'rgba(255,255,255,0.25)';
    rough.ctx.beginPath();
    rough.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    rough.ctx.fill();
  }

  const set: PBRSet = {
    map: layerTexture(albedo, true),
    roughnessMap: layerTexture(rough, false),
    normalMap: heightToNormal(heightL, 0.4),
  };
  pbrCache.set(key, set);
  return set;
}

/** Hand-painted plywood sign: Danish text lines, brush-uneven paint. */
export function makePaintedSign(lines: string[], opts?: { width?: number; height?: number }): THREE.Texture {
  const w = opts?.width ?? 512;
  const h = opts?.height ?? 256;
  const key = `sign|${w}x${h}|${lines.join('\u0000')}`;
  const hit = signCache.get(key);
  if (hit) return hit;

  // Deterministic seed from the text content.
  let seed = 2166136261 >>> 0;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) seed = Math.imul(seed ^ line.charCodeAt(i), 16777619) >>> 0;
  }
  const rng = mulberry32(seed ^ (w * 31 + h));

  // Plywood with horizontal wood-grain streaks + weathering blotches.
  const grainF = fbmField(256, 3, 28, 3, seed ^ 0x77e1);
  const weatherF = fbmField(128, 3, 3, 3, seed ^ 0x2bd9);
  const layer = makeCanvas(w, h);
  const img = layer.ctx.createImageData(w, h);
  const d = img.data;
  const base = hexToRgb('#8a7a5e');
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const grain = sampleTile(grainF, 256, u, v);
      const weather = sampleTile(weatherF, 128, u, v);
      const speck = hash2(x, y, seed ^ 0x99c5);
      const lum = 1 + (grain - 0.5) * 0.13 + (weather - 0.5) * 0.16 + (speck - 0.5) * 0.05;
      const i = (y * w + x) * 4;
      d[i] = base[0] * lum;
      d[i + 1] = base[1] * lum * (1 - (weather - 0.5) * 0.04); // bleach slightly green-grey
      d[i + 2] = base[2] * lum;
      d[i + 3] = 255;
    }
  }
  layer.ctx.putImageData(img, 0, 0);

  // Edge weathering vignette.
  const edge = layer.ctx.createLinearGradient(0, 0, 0, h);
  edge.addColorStop(0, 'rgba(40,36,28,0.18)');
  edge.addColorStop(0.18, 'rgba(40,36,28,0)');
  edge.addColorStop(0.82, 'rgba(40,36,28,0)');
  edge.addColorStop(1, 'rgba(40,36,28,0.24)');
  layer.ctx.fillStyle = edge;
  layer.ctx.fillRect(0, 0, w, h);

  // Hand-painted charcoal lettering, sized to fit, jittered per character.
  const ctx = layer.ctx;
  const upper = lines.map((l) => l.toUpperCase());
  const fontFor = (px: number) => `700 ${Math.max(8, Math.round(px))}px "Arial Narrow", Arial, sans-serif`;
  if (upper.length > 0 && upper.some((l) => l.length > 0)) {
    let fontPx = Math.min((h * 0.82) / upper.length / 1.28, h * 0.5);
    ctx.font = fontFor(fontPx);
    let maxW = 1;
    for (const line of upper) maxW = Math.max(maxW, ctx.measureText(line).width);
    fontPx *= Math.min(1, (w * 0.86) / maxW);
    ctx.font = fontFor(fontPx);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const lineH = fontPx * 1.28;
    const y0 = h / 2 - ((upper.length - 1) * lineH) / 2;
    const drips: Array<[number, number]> = [];
    for (let li = 0; li < upper.length; li++) {
      const line = upper[li];
      const y = y0 + li * lineH;
      let x = (w - ctx.measureText(line).width) / 2;
      for (const ch of line) {
        const cw = ctx.measureText(ch).width;
        if (ch !== ' ') {
          const rot = (rng() - 0.5) * 2 * (2 * Math.PI / 180); // ±2°
          const jy = (rng() - 0.5) * 4; // ±2 px
          ctx.save();
          ctx.translate(x + cw / 2, y + jy);
          ctx.rotate(rot);
          ctx.globalAlpha = 0.85 + rng() * 0.15;
          ctx.fillStyle = '#26262a';
          ctx.fillText(ch, -cw / 2, 0);
          ctx.restore();
          if (rng() < 0.08) drips.push([x + cw * (0.3 + rng() * 0.4), y + fontPx * 0.42]);
        }
        x += cw;
      }
    }
    ctx.globalAlpha = 1;
    // Paint drips: short vertical runs below random letters, fading out.
    for (const [dx, dy] of drips) {
      const len = 6 + rng() * 24;
      const dw = 1.5 + rng() * 1.5;
      const g = ctx.createLinearGradient(0, dy, 0, dy + len);
      g.addColorStop(0, 'rgba(38,38,42,0.75)');
      g.addColorStop(1, 'rgba(38,38,42,0)');
      ctx.fillStyle = g;
      ctx.fillRect(dx - dw / 2, dy, dw, len);
    }
    // Worn paint: faint plywood-coloured scuffs dragged across the letters.
    for (let s = 0; s < 5; s++) {
      const pts = randomWalk(rng, rng() * w, rng() * h, (rng() - 0.5) * 0.4, 6 + Math.floor(rng() * 8), w / 16, 0.25);
      strokePath(ctx, pts, `rgba(${base[0]},${base[1]},${base[2]},${0.1 + rng() * 0.12})`, 1 + rng() * 2);
    }
  }

  const tex = layerTexture(layer, true);
  signCache.set(key, tex);
  return tex;
}

/**
 * Worn interior plank floor (candle flats): ~14 cm planks running along the
 * tile's v axis, per-plank luminance/warm-hue jitter around #6b5b48, joint
 * gaps, sparse knots, and walk-path sheen wear in the roughness. Tile ≈ 2 m.
 */
export function makeWoodFloor(seed = 101): PBRSet {
  const key = `wood|${seed}`;
  const hit = pbrCache.get(key);
  if (hit) return hit;

  const size = 1024;
  const rng = mulberry32(seed);
  const cols = 14; // 2 m / 14 ≈ 14.3 cm plank pitch
  const colW = size / cols;
  // Grain streaks elongated ALONG the plank (v axis): many periods across,
  // few along. Sampled with a per-plank offset so neighbours never match.
  const grainF = fbmField(512, 36, 5, 3, seed ^ 0x6f2b);
  // Broad soft blobs: where high, the finish is scuffed smooth (walk paths).
  const scuffF = fbmField(128, 3, 3, 3, seed ^ 0x31a9);

  const albedo = makeCanvas(size);
  const rough = makeCanvas(size);
  const heightL = makeCanvas(size);
  const aImg = albedo.ctx.createImageData(size, size);
  const rImg = rough.ctx.createImageData(size, size);
  const hImg = heightL.ctx.createImageData(size, size);
  const aD = aImg.data;
  const rD = rImg.data;
  const hD = hImg.data;
  const base = hexToRgb('#6b5b48');

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const col = Math.min(cols - 1, Math.floor(x / colW));
      const xin = x - col * colW;
      const edgePx = Math.min(xin, colW - xin);
      // Two ~1 m planks per column with a per-column butt-joint phase.
      // Identity (col, k) is wrap-stable: the plank crossing the tile seam
      // gets identical jitter on both sides.
      const phase = hash2(col, 977, seed ^ 0x5d11) * 0.5;
      const tv = (((v - phase) % 1) + 1) % 1;
      const k = tv < 0.5 ? 0 : 1;
      const tj = tv % 0.5;
      const jointPx = Math.min(tj, 0.5 - tj) * size;
      const p0 = hash2(col, k, seed ^ 0x77c1); // luminance jitter
      const p1 = hash2(col, k, seed ^ 0x2bd7); // warm-hue jitter
      const p2 = hash2(col, k, seed ^ 0x90ef); // sheen jitter
      const grain = sampleTile(grainF, 512, u + p0 * 0.73, v + p1 * 0.37);
      const scuff = sampleTile(scuffF, 128, u, v);
      const speck = hash2(x, y, seed ^ 0xae53);
      // Walk-path wear mask: smoothstep over the broad blob field.
      const wt = Math.min(1, Math.max(0, (scuff - 0.52) / 0.2));
      const wear = wt * wt * (3 - 2 * wt);
      const gap = edgePx < 1.5 || jointPx < 1.1;
      const warm = p1 - 0.5;
      const lum = 1 + (p0 - 0.5) * 0.17 + (grain - 0.5) * 0.2 + (speck - 0.5) * 0.06 + wear * 0.05;
      let rr = base[0] * lum + warm * 13;
      let gg = base[1] * lum + warm * 3;
      let bb = base[2] * lum - warm * 9;
      let rv = 0.68 + (p2 - 0.5) * 0.1 + (grain - 0.5) * 0.08 - wear * 0.2;
      let hv = 0.5 + (p0 - 0.5) * 0.2 + (grain - 0.5) * 0.12;
      if (gap) {
        // Dark joint gap, carved deep in the height so the normal pops.
        rr *= 0.38;
        gg *= 0.38;
        bb *= 0.38;
        rv = Math.min(1, rv + 0.18);
        hv = 0.12;
      }
      const i = (y * size + x) * 4;
      aD[i] = rr;
      aD[i + 1] = gg;
      aD[i + 2] = bb;
      aD[i + 3] = 255;
      const rb = Math.max(0, Math.min(1, rv)) * 255;
      rD[i] = rb;
      rD[i + 1] = rb;
      rD[i + 2] = rb;
      rD[i + 3] = 255;
      const hb = Math.max(0, Math.min(1, hv)) * 255;
      hD[i] = hb;
      hD[i + 1] = hb;
      hD[i + 2] = hb;
      hD[i + 3] = 255;
    }
  }
  albedo.ctx.putImageData(aImg, 0, 0);
  rough.ctx.putImageData(rImg, 0, 0);
  heightL.ctx.putImageData(hImg, 0, 0);

  // Sparse knots: dark oval stretched along the grain + faint ring, dimpled
  // in the height, polished in the roughness. Inset from the tile edge so
  // the wrap stays seam-free.
  const nKnots = 6 + Math.floor(rng() * 5);
  for (let n = 0; n < nKnots; n++) {
    const kx = 50 + rng() * (size - 100);
    const ky = 50 + rng() * (size - 100);
    const r = 4 + rng() * 6;
    const g = albedo.ctx.createRadialGradient(kx, ky, 0, kx, ky, r * 1.7);
    g.addColorStop(0, 'rgba(46,35,25,0.85)');
    g.addColorStop(0.5, 'rgba(58,45,33,0.45)');
    g.addColorStop(1, 'rgba(58,45,33,0)');
    albedo.ctx.fillStyle = g;
    albedo.ctx.beginPath();
    albedo.ctx.ellipse(kx, ky, r, r * 1.7, 0, 0, Math.PI * 2);
    albedo.ctx.fill();
    albedo.ctx.strokeStyle = 'rgba(40,30,22,0.3)';
    albedo.ctx.lineWidth = 1.2;
    albedo.ctx.beginPath();
    albedo.ctx.ellipse(kx, ky, r * 1.25, r * 2.1, 0, 0, Math.PI * 2);
    albedo.ctx.stroke();
    heightL.ctx.fillStyle = 'rgba(0,0,0,0.4)';
    heightL.ctx.beginPath();
    heightL.ctx.ellipse(kx, ky, r * 0.8, r * 1.4, 0, 0, Math.PI * 2);
    heightL.ctx.fill();
    rough.ctx.fillStyle = 'rgba(0,0,0,0.2)';
    rough.ctx.beginPath();
    rough.ctx.ellipse(kx, ky, r, r * 1.7, 0, 0, Math.PI * 2);
    rough.ctx.fill();
  }

  const set: PBRSet = {
    map: layerTexture(albedo, true),
    roughnessMap: layerTexture(rough, false),
    normalMap: heightToNormal(heightL, 0.55),
  };
  pbrCache.set(key, set);
  return set;
}

/**
 * Interior plaster: the calmer cousin of the façade — fine grain, very
 * subtle blotch, faint darkening at the bottom (skirting grime). NO streaks;
 * rain never reaches in here. Tile ≈ 3 m.
 */
export function makeInteriorPlaster(baseColor: string, seed = 113): PBRSet {
  const key = `intplaster|${baseColor}|${seed}`;
  const hit = pbrCache.get(key);
  if (hit) return hit;

  const size = 512;
  const blotchF = fbmField(256, 4, 4, 4, seed ^ 0x44d1);
  const grainF = fbmField(512, 40, 40, 3, seed ^ 0x18b3);

  const albedo = makeCanvas(size);
  const rough = makeCanvas(size);
  const heightL = makeCanvas(size);
  const aImg = albedo.ctx.createImageData(size, size);
  const rImg = rough.ctx.createImageData(size, size);
  const hImg = heightL.ctx.createImageData(size, size);
  const aD = aImg.data;
  const rD = rImg.data;
  const hD = hImg.data;
  const base = hexToRgb(baseColor);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    // CanvasTexture flipY: the canvas BOTTOM rows land at uv v≈0, i.e. the
    // floor line — that is where the skirting grime belongs.
    const b = Math.max(0, (y / size - 0.86) / 0.14);
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const blotch = sampleTile(blotchF, 256, u, v);
      const grain = sampleTile(grainF, 512, u, v);
      const speck = hash2(x, y, seed ^ 0x7e39);
      const grime = b * b * (0.7 + 0.3 * blotch);
      const lum = (1 + (blotch - 0.5) * 0.045 + (grain - 0.5) * 0.05 + (speck - 0.5) * 0.035) * (1 - grime * 0.13);
      const i = (y * size + x) * 4;
      aD[i] = base[0] * lum;
      aD[i + 1] = base[1] * lum;
      aD[i + 2] = base[2] * lum;
      aD[i + 3] = 255;
      const rv = (0.84 + (grain - 0.5) * 0.16 + grime * 0.06) * 255;
      rD[i] = rv;
      rD[i + 1] = rv;
      rD[i + 2] = rv;
      rD[i + 3] = 255;
      const hv = (0.5 + (grain - 0.5) * 0.2 + (blotch - 0.5) * 0.1 + (speck - 0.5) * 0.04) * 255;
      hD[i] = hv;
      hD[i + 1] = hv;
      hD[i + 2] = hv;
      hD[i + 3] = 255;
    }
  }
  albedo.ctx.putImageData(aImg, 0, 0);
  rough.ctx.putImageData(rImg, 0, 0);
  heightL.ctx.putImageData(hImg, 0, 0);

  const set: PBRSet = {
    map: layerTexture(albedo, true),
    roughnessMap: layerTexture(rough, false),
    normalMap: heightToNormal(heightL, 0.3),
  };
  pbrCache.set(key, set);
  return set;
}

/** Dispose every texture created by this module (scene teardown). */
export function disposeAllGeneratedTextures(): void {
  for (const tex of registry) tex.dispose();
  registry.length = 0;
  pbrCache.clear();
  signCache.clear();
}
