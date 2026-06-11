import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchWorldMaterial } from '../graphics/worldMaterial';
import {
  makeAsphalt,
  makeSidewalk,
  makePlasterFacade,
  makeBrickFacade,
  makeAshDrift,
  type PBRSet,
} from './textures';

/**
 * Procedural Copenhagen kit (§6.6): parametric 5-storey perimeter-block
 * façades (window grid, shopfronts, cornices, mansard roofs, drainpipes),
 * street ground with curbs + ash-drifted gutters, and distant skyline
 * silhouette cards. Static geometry is merged per block; draw calls are
 * precious (≤300 per scene including everything else).
 *
 * Every material is patched with patchWorldMaterial(); roofs/ledges/ground
 * get high ashAmount, vertical walls low (≈0.35), glass near zero.
 */
export interface FacadeParams {
  /** Window bays across. */
  bays: number;
  /** Storeys (Copenhagen perimeter block: 5–6). */
  floors: number;
  style: 'plaster' | 'brick';
  /** Base tint, will be desaturated toward the act palette. */
  tint: string;
  seed: number;
  /** Ground-floor shopfront strip instead of flat wall. */
  shopfront?: boolean;
  /** Number of windows with faint candle flicker (emissive). */
  litWindows?: number;
}

// ---------------------------------------------------------------------------
// Kit dimensions (metres) — Copenhagen perimeter-block proportions.
// ---------------------------------------------------------------------------
const BAY_W = 3.0;
const FLOOR_H = 3.1;
const PLINTH_H = 0.7;
const BODY_DEPTH = 12;
const WIN_W = 1.25;
const WIN_H = 1.7;
const WIN_SILL_Y = 0.9; // window bottom above floor line
const GLASS_INSET = 0.18;
const ROOF_H = 2.6;
const ROOF_SLOPE_DEG = 70;
const SHOP_OPEN_W = 2.2;
const SHOP_OPEN_H = 2.6;
const SHOP_OPEN_BOTTOM = 0.8;

// Texture tile sizes agreed with textures.ts (metres per repeat).
const TILE_ASPHALT = 6;
const TILE_SIDEWALK = 2.4;
const TILE_PLASTER = 4;
const TILE_BRICK = 2;
const TILE_ASH = 3;

// ---------------------------------------------------------------------------
// Deterministic helpers (build-time; flicker helpers further below are
// allocation-free for per-frame use).
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sstep(x: number, e0: number, e1: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function vnoise2(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm2(x: number, z: number): number {
  return (
    0.55 * vnoise2(x, z) +
    0.3 * vnoise2(x * 2.1 + 7.3, z * 2.1 + 3.1) +
    0.15 * vnoise2(x * 4.3 + 13.7, z * 4.3 + 9.2)
  );
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Axis-aligned façade rectangle in the local XY plane (facing +Z, at z=0),
 * with UVs in world metres / tile so adjacent strips share the same texture
 * space seamlessly.
 */
function wallRect(x0: number, x1: number, y0: number, y1: number, tile: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, pos.getX(i) / tile, pos.getY(i) / tile);
  }
  return g;
}

/** Indexed single quad (a,b,c,d counter-clockwise seen from outside). */
function quadGeo(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz]), 3),
  );
  const w = Math.hypot(bx - ax, by - ay, bz - az) * 0.25;
  const h = Math.hypot(dx - ax, dy - ay, dz - az) * 0.25;
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, w, 0, w, h, 0, h]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/** Multiply plane UVs (call BEFORE any rotation while uv ↔ xy still align). */
function scaleUVs(geo: THREE.BufferGeometry, su: number, sv: number, ou = 0, ov = 0): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  }
}

function mergeInto(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}

function applyPBR(mat: THREE.MeshStandardMaterial, set: PBRSet): void {
  mat.map = set.map;
  if (set.roughnessMap) {
    mat.roughnessMap = set.roughnessMap;
    mat.roughness = 1.0;
  }
  if (set.normalMap) mat.normalMap = set.normalMap;
}

/**
 * One window unit's painted frame: casing border + 1 vertical + 1 horizontal
 * mullion (dannebrogsvindue — crossbar above the middle). Built once at the
 * origin (window centre), cloned + translated per window.
 */
function buildWindowFrameUnit(): THREE.BufferGeometry {
  const members: THREE.BufferGeometry[] = [];
  // Casing border
  members.push(new THREE.BoxGeometry(WIN_W + 0.18, 0.08, 0.09).translate(0, WIN_H / 2 + 0.04, 0));
  members.push(new THREE.BoxGeometry(WIN_W + 0.18, 0.08, 0.09).translate(0, -WIN_H / 2 - 0.04, 0));
  members.push(new THREE.BoxGeometry(0.08, WIN_H + 0.16, 0.09).translate(-(WIN_W / 2 + 0.04), 0, 0));
  members.push(new THREE.BoxGeometry(0.08, WIN_H + 0.16, 0.09).translate(WIN_W / 2 + 0.04, 0, 0));
  // Mullions
  members.push(new THREE.BoxGeometry(0.055, WIN_H, 0.07).translate(0, 0, 0.005));
  members.push(new THREE.BoxGeometry(WIN_W, 0.055, 0.07).translate(0, WIN_H * 0.18, 0.005));
  return mergeInto(members);
}

/**
 * One contiguous façade block. Returns a Group whose userData.flickerMats
 * is THREE.MeshStandardMaterial[] — updateCityFlicker() animates these.
 * Origin: centre of the building footprint at ground level, façade faces +X side?
 * No: façade FRONT faces +Z of the group; caller rotates/positions.
 */
export function buildFacadeBlock(params: FacadeParams): THREE.Group {
  const rng = mulberry32(params.seed);
  const bays = Math.max(1, Math.floor(params.bays));
  const floors = Math.max(1, Math.floor(params.floors));
  const W = bays * BAY_W;
  const H = PLINTH_H + floors * FLOOR_H;
  const D = BODY_DEPTH;
  const tile = params.style === 'plaster' ? TILE_PLASTER : TILE_BRICK;
  const shopfront = params.shopfront === true;

  const wallGeos: THREE.BufferGeometry[] = [];
  const plinthGeos: THREE.BufferGeometry[] = [];
  const frameGeos: THREE.BufferGeometry[] = [];
  const glassGeos: THREE.BufferGeometry[] = [];
  const sillGeos: THREE.BufferGeometry[] = [];
  const roofGeos: THREE.BufferGeometry[] = [];
  const candleGeos: THREE.BufferGeometry[] = [];

  const frameUnit = buildWindowFrameUnit();
  // Window centres on the front face (candle-flicker candidates).
  const windows: Array<{ x: number; y: number }> = [];

  // ---- Front face: wall strips around the window grid ----
  const firstWindowFloor = shopfront ? 1 : 0;
  for (let f = firstWindowFloor; f < floors; f++) {
    const fl = PLINTH_H + f * FLOOR_H;
    const winB = fl + WIN_SILL_Y;
    const winT = winB + WIN_H;
    wallGeos.push(wallRect(-W / 2, W / 2, fl, winB, tile));
    wallGeos.push(wallRect(-W / 2, W / 2, winT, fl + FLOOR_H, tile));
    // Piers between windows
    let prevX = -W / 2;
    for (let b = 0; b < bays; b++) {
      const wl = -W / 2 + b * BAY_W + (BAY_W - WIN_W) / 2;
      wallGeos.push(wallRect(prevX, wl, winB, winT, tile));
      prevX = wl + WIN_W;
      windows.push({ x: wl + WIN_W / 2, y: (winB + winT) / 2 });
    }
    wallGeos.push(wallRect(prevX, W / 2, winB, winT, tile));
  }

  // ---- Shopfront ground band ----
  if (shopfront) {
    const fl = PLINTH_H;
    const bandTop = fl + FLOOR_H;
    const openB = SHOP_OPEN_BOTTOM;
    const openT = openB + SHOP_OPEN_H;
    wallGeos.push(wallRect(-W / 2, W / 2, fl, openB, tile));
    wallGeos.push(wallRect(-W / 2, W / 2, openT, bandTop, tile));
    const awningBay = Math.floor(rng() * bays);
    let prevX = -W / 2;
    for (let b = 0; b < bays; b++) {
      const ol = -W / 2 + b * BAY_W + (BAY_W - SHOP_OPEN_W) / 2;
      wallGeos.push(wallRect(prevX, ol, openB, openT, tile));
      prevX = ol + SHOP_OPEN_W;
      const cx = ol + SHOP_OPEN_W / 2;
      const cy = (openB + openT) / 2;
      const boarded = b !== awningBay && rng() < 0.45;
      if (boarded) {
        // Plywood planks (merged into the dark plinth mesh — weathered boards).
        const plankCount = 6;
        for (let p = 0; p < plankCount; p++) {
          const py = openB + 0.22 + p * (SHOP_OPEN_H - 0.3) / (plankCount - 1);
          const plank = new THREE.BoxGeometry(SHOP_OPEN_W + 0.2, 0.38, 0.045);
          plank.rotateZ((rng() - 0.5) * 0.05);
          plank.translate(cx + (rng() - 0.5) * 0.06, py, D / 2 - 0.1 + (rng() - 0.5) * 0.02);
          plinthGeos.push(plank);
        }
      } else {
        glassGeos.push(
          new THREE.PlaneGeometry(SHOP_OPEN_W - 0.04, SHOP_OPEN_H - 0.04).translate(cx, cy, D / 2 - GLASS_INSET),
        );
      }
      if (b === awningBay) {
        // Bare awning frame: front bar + two sloped arms (canvas long gone).
        frameGeos.push(new THREE.BoxGeometry(SHOP_OPEN_W, 0.05, 0.05).translate(cx, openT - 0.5, D / 2 + 0.95));
        const armTilt = Math.atan2(0.5, 0.95);
        for (const s of [-1, 1]) {
          const arm = new THREE.BoxGeometry(0.05, 0.05, 1.1);
          arm.rotateX(armTilt);
          arm.translate(cx + s * (SHOP_OPEN_W / 2 - 0.1), openT - 0.25, D / 2 + 0.475);
          frameGeos.push(arm);
        }
      }
    }
    wallGeos.push(wallRect(prevX, W / 2, openB, openT, tile));
  }

  // ---- Side + back faces (windowless party-wall style) ----
  const sideL = wallRect(-D / 2, D / 2, 0, H, tile);
  sideL.rotateY(-Math.PI / 2);
  sideL.translate(-W / 2, 0, 0);
  wallGeos.push(sideL);
  const sideR = wallRect(-D / 2, D / 2, 0, H, tile);
  sideR.rotateY(Math.PI / 2);
  sideR.translate(W / 2, 0, 0);
  wallGeos.push(sideR);
  const back = wallRect(-W / 2, W / 2, 0, H, tile);
  back.rotateY(Math.PI);
  back.translate(0, 0, -D / 2);
  wallGeos.push(back);

  // ---- Plinth: darker painted band wrapping the base, slightly proud ----
  plinthGeos.push(new THREE.BoxGeometry(W + 0.12, PLINTH_H, D + 0.12).translate(0, PLINTH_H / 2, 0));

  // ---- Windows: frames + glass + ash-capped sills ----
  for (const w of windows) {
    frameGeos.push(frameUnit.clone().translate(w.x, w.y, D / 2 - 0.06));
    glassGeos.push(
      new THREE.PlaneGeometry(WIN_W - 0.06, WIN_H - 0.06).translate(w.x, w.y, D / 2 - GLASS_INSET),
    );
    sillGeos.push(
      new THREE.BoxGeometry(WIN_W + 0.22, 0.07, 0.2).translate(w.x, w.y - WIN_H / 2 - 0.035, D / 2 + 0.02),
    );
  }
  frameUnit.dispose();

  // ---- Drainpipes at bay seams, merged into the frames mesh ----
  const pipeXs: number[] =
    bays >= 3
      ? [-W / 2 + BAY_W * 1, W / 2 - BAY_W * 1]
      : [-(W / 2 - 0.25), W / 2 - 0.25];
  for (const px of pipeXs) {
    const pipe = new THREE.CylinderGeometry(0.05, 0.05, H - 0.2, 8);
    pipe.translate(px, (H - 0.2) / 2 + 0.1, D / 2 + 0.09);
    frameGeos.push(pipe);
  }

  // ---- Cornice: overhanging cap slab above the top floor ----
  roofGeos.push(new THREE.BoxGeometry(W + 0.5, 0.22, D + 0.5).translate(0, H + 0.11, 0));

  // ---- Mansard roof: 70° sloped frustum, slightly inset, flat cap ----
  const y1 = H + 0.22;
  const y2 = y1 + ROOF_H;
  const run = ROOF_H / Math.tan(THREE.MathUtils.degToRad(ROOF_SLOPE_DEG));
  const wb = W / 2 - 0.18;
  const db = D / 2 - 0.18;
  const wt = Math.max(0.4, wb - run);
  const dt = Math.max(0.4, db - run);
  roofGeos.push(quadGeo(-wb, y1, db, wb, y1, db, wt, y2, dt, -wt, y2, dt)); // front
  roofGeos.push(quadGeo(wb, y1, -db, -wb, y1, -db, -wt, y2, -dt, wt, y2, -dt)); // back
  roofGeos.push(quadGeo(wb, y1, db, wb, y1, -db, wt, y2, -dt, wt, y2, dt)); // right
  roofGeos.push(quadGeo(-wb, y1, -db, -wb, y1, db, -wt, y2, dt, -wt, y2, -dt)); // left
  roofGeos.push(quadGeo(-wt, y2, dt, wt, y2, dt, wt, y2, -dt, -wt, y2, -dt)); // cap

  // ---- Dormers on the front slope ----
  const dormerCount = W >= 12 ? 2 + Math.floor(rng() * 2) : 2;
  const dormerSpan = Math.max(0.6, wb - 1.4);
  for (let i = 0; i < dormerCount; i++) {
    const dx = dormerCount === 1 ? 0 : -dormerSpan + (2 * dormerSpan * i) / (dormerCount - 1);
    roofGeos.push(new THREE.BoxGeometry(1.15, 1.25, 1.5).translate(dx, y1 + 0.95, db - 0.55));
    glassGeos.push(new THREE.PlaneGeometry(0.7, 0.85).translate(dx, y1 + 1.0, db + 0.201));
  }

  // ---- Lit windows: candle planes just behind the glass ----
  const litCount = Math.min(params.litWindows ?? 0, windows.length);
  if (litCount > 0) {
    const order = windows.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    for (let k = 0; k < litCount; k++) {
      const w = windows[order[k]];
      candleGeos.push(new THREE.PlaneGeometry(1.05, 1.45).translate(w.x, w.y, D / 2 - 0.26));
    }
  }

  // ---- Materials ----
  const facadeSet = params.style === 'plaster'
    ? makePlasterFacade(params.tint, params.seed)
    : makeBrickFacade(params.tint, params.seed);
  const wallMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.0 });
  applyPBR(wallMat, facadeSet);
  patchWorldMaterial(wallMat, { ashAmount: 0.3 });

  const plinthMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(params.tint).multiplyScalar(0.5),
    roughness: 0.92,
    metalness: 0.0,
  });
  patchWorldMaterial(plinthMat, { ashAmount: 0.5 });

  // Once-white painted frames, fourteen days into the ash. Near-white reads
  // as rows of lit windows at street distance — keep them weathered grey.
  const frameMat = new THREE.MeshStandardMaterial({
    color: '#8e8c86',
    roughness: 0.8,
    metalness: 0.0,
  });
  patchWorldMaterial(frameMat, { ashAmount: 0.4 });

  const glassMat = new THREE.MeshStandardMaterial({
    color: '#14171a',
    roughness: 0.55,
    metalness: 0.05,
  });
  // Restraint: the grazing winter sun + bright overcast IBL turn smooth
  // glass into rows of white glints that read as lit offices. Dusty dead
  // glass is rough and dim.
  glassMat.envMapIntensity = 0.2;
  patchWorldMaterial(glassMat, { ashAmount: 0.08 });

  const sillMat = new THREE.MeshStandardMaterial({
    color: '#c9c7c0',
    roughness: 0.9,
    metalness: 0.0,
  });
  patchWorldMaterial(sillMat, { ashAmount: 1.5 });

  const roofMat = new THREE.MeshStandardMaterial({
    color: '#43484d',
    roughness: 0.88,
    metalness: 0.08,
  });
  patchWorldMaterial(roofMat, { ashAmount: 1.4 });

  // ---- Assemble (≤7 meshes) ----
  const group = new THREE.Group();
  group.name = 'facadeBlock';

  const addMesh = (
    geos: THREE.BufferGeometry[],
    mat: THREE.MeshStandardMaterial,
    name: string,
    cast: boolean,
  ): THREE.Mesh | null => {
    if (geos.length === 0) return null;
    const mesh = new THREE.Mesh(mergeInto(geos), mat);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  addMesh(wallGeos, wallMat, 'walls', true);
  addMesh(plinthGeos, plinthMat, 'plinth', true);
  addMesh(frameGeos, frameMat, 'frames', true);
  addMesh(glassGeos, glassMat, 'glass', false);
  addMesh(sillGeos, sillMat, 'sills', true);
  addMesh(roofGeos, roofMat, 'roof', true);

  const flickerMats: THREE.MeshStandardMaterial[] = [];
  if (candleGeos.length > 0) {
    // The hue must SURVIVE tone mapping: above ~1.3 intensity AgX
    // desaturates candle amber to electric white. Target on-screen pixel
    // ≈ rgb(215,150,70).
    const candleMat = new THREE.MeshStandardMaterial({
      color: '#1a1107',
      emissive: '#E8A23C',
      emissiveIntensity: 0.7,
      roughness: 1.0,
      metalness: 0.0,
    });
    patchWorldMaterial(candleMat, { ashAmount: 0 });
    const candles = addMesh(candleGeos, candleMat, 'candles', false);
    if (candles) candles.receiveShadow = false;
    flickerMats.push(candleMat);
  }

  group.userData.flickerMats = flickerMats;
  group.userData.flickerPhase = rng() * 100;
  return group;
}

// ---------------------------------------------------------------------------
// Street ground
// ---------------------------------------------------------------------------

/** CPU-displace a flat (rotated) drift strip; local x ∈ [-0.8, 0.8]. */
function displaceDrift(
  geo: THREE.BufferGeometry,
  peakT: number,
  maxH: number,
  taperLow: boolean,
  taperHigh: boolean,
  seedOff: number,
): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const sigma = 0.26;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const t = (x + 0.8) / 1.6;
    let env = Math.exp(-((t - peakT) * (t - peakT)) / (2 * sigma * sigma));
    if (taperLow) env *= sstep(t, 0.0, 0.2);
    if (taperHigh) env *= 1 - sstep(t, 0.8, 1.0);
    // Long-wave presence so drifts come and go along the street, plus fBm humps.
    const presence = vnoise2((z + seedOff) * 0.05, seedOff * 0.7);
    const humps = fbm2((z + seedOff) * 0.16, x * 0.7 + seedOff);
    const h = maxH * env * (0.3 + 0.85 * presence) * (0.45 + 0.85 * humps);
    pos.setY(i, Math.min(maxH, Math.max(0, h)));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

function makeDriftStrip(
  length: number,
  x0: number,
  y0: number,
  peakT: number,
  maxH: number,
  taperLow: boolean,
  taperHigh: boolean,
  seedOff: number,
): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(1.6, length, 6, 160);
  scaleUVs(geo, 1.6 / TILE_ASH, length / TILE_ASH, Math.abs(x0) * 0.37, seedOff * 0.11);
  geo.rotateX(-Math.PI / 2);
  displaceDrift(geo, peakT, maxH, taperLow, taperHigh, seedOff);
  geo.translate(x0, y0, 0);
  return geo;
}

/**
 * Street ground running along Z, centred on x=0: asphalt road, granite
 * curbs, sidewalk slabs both sides, displaced ash-drift strips in the
 * gutters and against the building line.
 */
export function buildStreetGround(length: number, roadWidth: number, sidewalkWidth: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'streetGround';

  // Road
  const roadGeo = new THREE.PlaneGeometry(roadWidth, length);
  scaleUVs(roadGeo, roadWidth / TILE_ASPHALT, length / TILE_ASPHALT);
  roadGeo.rotateX(-Math.PI / 2);
  const roadMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.0 });
  applyPBR(roadMat, makeAsphalt(11));
  patchWorldMaterial(roadMat, { ashAmount: 1.7 });
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.name = 'road';
  road.receiveShadow = true;
  group.add(road);

  // Curbs (granite)
  const curbGeos: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    curbGeos.push(new THREE.BoxGeometry(0.3, 0.13, length).translate(s * (roadWidth / 2 + 0.15), 0.065, 0));
  }
  const curbMat = new THREE.MeshStandardMaterial({
    color: '#75787a',
    roughness: 0.82,
    metalness: 0.0,
  });
  patchWorldMaterial(curbMat, { ashAmount: 1.7 });
  const curbs = new THREE.Mesh(mergeInto(curbGeos), curbMat);
  curbs.name = 'curbs';
  curbs.castShadow = true;
  curbs.receiveShadow = true;
  group.add(curbs);

  // Sidewalks: from the curb's outer edge to the building line
  // (x = roadWidth/2 + sidewalkWidth), flush with the curb top.
  const walkGeos: THREE.BufferGeometry[] = [];
  const walkW = sidewalkWidth - 0.3;
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(walkW, length);
    scaleUVs(g, walkW / TILE_SIDEWALK, length / TILE_SIDEWALK);
    g.rotateX(-Math.PI / 2);
    g.translate(s * (roadWidth / 2 + 0.3 + walkW / 2), 0.13, 0);
    walkGeos.push(g);
  }
  const walkMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.0 });
  applyPBR(walkMat, makeSidewalk(23));
  patchWorldMaterial(walkMat, { ashAmount: 1.7 });
  const walks = new THREE.Mesh(mergeInto(walkGeos), walkMat);
  walks.name = 'sidewalks';
  walks.receiveShadow = true;
  group.add(walks);

  // Ash drifts: gutter strips (pile against the curb) + building-line strips
  // (taller, peak right at the wall plane).
  const driftGeos: THREE.BufferGeometry[] = [];
  const gutterX = roadWidth / 2 - 0.4;
  const wallX = roadWidth / 2 + sidewalkWidth - 0.3;
  driftGeos.push(makeDriftStrip(length, -gutterX, 0.012, 0.32, 0.25, true, true, 5.1));
  driftGeos.push(makeDriftStrip(length, gutterX, 0.012, 0.68, 0.25, true, true, 41.7));
  driftGeos.push(makeDriftStrip(length, -wallX, 0.142, 0.22, 0.4, false, true, 17.3));
  driftGeos.push(makeDriftStrip(length, wallX, 0.142, 0.78, 0.4, true, false, 29.9));
  const driftMat = new THREE.MeshStandardMaterial({ roughness: 1.0, metalness: 0.0 });
  applyPBR(driftMat, makeAshDrift(7));
  patchWorldMaterial(driftMat, { ashAmount: 1.8 });
  const drifts = new THREE.Mesh(mergeInto(driftGeos), driftMat);
  drifts.name = 'ashDrifts';
  drifts.receiveShadow = true;
  group.add(drifts);

  return group;
}

// ---------------------------------------------------------------------------
// Skyline silhouette ring
// ---------------------------------------------------------------------------

/** Distant rooftop-silhouette ring (incl. desaturated copper-green spires). */
export function buildSkylineCards(distance: number): THREE.Group {
  const rng = mulberry32(1337);
  const group = new THREE.Group();
  group.name = 'skylineCards';

  const darkGeos: THREE.BufferGeometry[] = [];
  const verdigrisGeos: THREE.BufferGeometry[] = [];
  const clusters = 9;

  for (let i = 0; i < clusters; i++) {
    const a = (i / clusters) * Math.PI * 2 + (rng() - 0.5) * 0.35;
    const r = distance * (0.92 + rng() * 0.2);
    const cx = Math.sin(a) * r;
    const cz = Math.cos(a) * r;

    const boxes = 2 + Math.floor(rng() * 3);
    for (let b = 0; b < boxes; b++) {
      const w = 8 + rng() * 12;
      const h = 12 + rng() * 20;
      const d = 8 + rng() * 10;
      const g = new THREE.BoxGeometry(w, h, d);
      g.rotateY(a + (rng() - 0.5) * 0.5);
      g.translate(cx + (rng() - 0.5) * 24, h / 2, cz + (rng() - 0.5) * 24);
      darkGeos.push(g);
    }

    if (i === 2 || i === 6) {
      // Verdigris spire (Copenhagen tower hint): dark shaft, green cone.
      const tower = new THREE.BoxGeometry(6, 20, 6);
      tower.rotateY(a);
      tower.translate(cx, 10, cz);
      darkGeos.push(tower);
      verdigrisGeos.push(new THREE.ConeGeometry(3.4, 13, 10).translate(cx, 26.5, cz));
    }
    if (i === 4) {
      // Dome (Marmorkirken hint): dark drum, green hemisphere.
      const drum = new THREE.BoxGeometry(11, 13, 11);
      drum.rotateY(a);
      drum.translate(cx, 6.5, cz);
      darkGeos.push(drum);
      verdigrisGeos.push(
        new THREE.SphereGeometry(6.8, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2).translate(cx, 13, cz),
      );
    }
  }

  const darkMat = new THREE.MeshStandardMaterial({
    color: '#2f343a',
    roughness: 0.95,
    metalness: 0.0,
  });
  patchWorldMaterial(darkMat, { ashAmount: 0.6 });
  const dark = new THREE.Mesh(mergeInto(darkGeos), darkMat);
  dark.name = 'skylineDark';
  dark.castShadow = false;
  dark.receiveShadow = false;
  group.add(dark);

  const verdigrisMat = new THREE.MeshStandardMaterial({
    color: '#5e6f68',
    roughness: 0.8,
    metalness: 0.1,
  });
  patchWorldMaterial(verdigrisMat, { ashAmount: 0.7 });
  const verdigris = new THREE.Mesh(mergeInto(verdigrisGeos), verdigrisMat);
  verdigris.name = 'skylineVerdigris';
  verdigris.castShadow = false;
  verdigris.receiveShadow = false;
  group.add(verdigris);

  return group;
}

// ---------------------------------------------------------------------------
// Candle flicker (per-frame; zero allocations)
// ---------------------------------------------------------------------------

function hash1(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth deterministic 1D value noise, 0..1. */
function smoothNoise1(t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i);
  return a + (hash1(i + 1) - a) * u;
}

/** Animate candle-window flicker (noise on emissiveIntensity). */
export function updateCityFlicker(blocks: THREE.Group[], elapsed: number): void {
  for (let b = 0; b < blocks.length; b++) {
    const ud = blocks[b].userData;
    const mats = ud.flickerMats as THREE.MeshStandardMaterial[] | undefined;
    if (!mats || mats.length === 0) continue;
    const phase = typeof ud.flickerPhase === 'number' ? ud.flickerPhase : 0;
    const fast = smoothNoise1(elapsed * 7 + phase);
    const slow = smoothNoise1(elapsed * 1.2 + phase * 1.71);
    // Occasional deeper dips: the slow noise gates intensity down to ~55%.
    const dip = 0.55 + 0.45 * sstep(slow, 0.18, 0.45);
    const intensity = (0.6 + 0.3 * fast) * dip;
    for (let m = 0; m < mats.length; m++) {
      mats[m].emissiveIntensity = intensity;
    }
  }
}

/**
 * Dispose geometries + materials of a kit-built group (textures are owned
 * and disposed by textures.ts via disposeAllGeneratedTextures()).
 */
export function disposeCityGroup(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      for (const m of mat) m.dispose();
    } else {
      mat.dispose();
    }
  });
}
