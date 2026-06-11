import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchWorldMaterial } from '../graphics/worldMaterial';
import { makeWoodFloor, makeInteriorPlaster, applyPBR } from './textures';
import { mulberry32 } from '../core/math';

/**
 * Candle interior kit (§5.2 Act I interiors, §6.8 exposure adaptation):
 * room shells behind façade openings — plaster walls, plank floor, ceiling,
 * doorway and blacked-out windows — dressed with lived-in furniture and lit
 * by candle clusters (warm 1900 K point light with noise flicker + small
 * emissive flame quads). The interior is dark relative to the street; the
 * post stack's exposure trigger does the "eyes adjusting" beat.
 *
 * Interiors are the one ash-free place (ashAmount 0 everywhere).
 */
export interface InteriorColliderDesc {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  yaw: number;
}

const WALL_T = 0.08; // half-extent of thin wall colliders
const DOOR_W = 0.95;
const DOOR_H = 2.05;

/** Cheap deterministic 1D noise for flicker (no allocations). */
function flickerNoise(t: number): number {
  const s = Math.sin(t * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/** Plane with UVs in metres/tile (matches cityKit's convention). */
function uvPlane(w: number, h: number, tile: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * h) / tile);
  }
  return g;
}

// ---------------------------------------------------------------------------
// CandleRig
// ---------------------------------------------------------------------------
export class CandleRig {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;

  private readonly flames: THREE.Mesh[] = [];
  private readonly phase: number;
  private readonly baseIntensity = 5.5;
  private readonly baseY: number;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];

  constructor(candleCount = 3, seed = 17) {
    const rng = mulberry32(seed);
    this.phase = rng() * 100;

    const waxMat = new THREE.MeshStandardMaterial({ color: '#d8cfc0', roughness: 0.6 });
    patchWorldMaterial(waxMat, { ashAmount: 0 });
    const flameMat = new THREE.MeshBasicMaterial({
      color: '#ffc98a',
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mats.push(waxMat, flameMat);

    let tallest = 0.08;
    const n = Math.max(1, Math.min(4, candleCount));
    for (let i = 0; i < n; i++) {
      const h = 0.06 + rng() * 0.08;
      tallest = Math.max(tallest, h);
      const r = 0.012 + rng() * 0.006;
      const geo = new THREE.CylinderGeometry(r * 0.92, r, h, 8);
      this.geos.push(geo);
      const candle = new THREE.Mesh(geo, waxMat);
      const a = rng() * Math.PI * 2;
      const d = n > 1 ? 0.025 + rng() * 0.04 : 0;
      candle.position.set(Math.cos(a) * d, h / 2, Math.sin(a) * d);
      candle.castShadow = false;
      this.group.add(candle);

      // Flame: two crossed quads above the wick.
      const fGeo = new THREE.PlaneGeometry(0.02, 0.04);
      this.geos.push(fGeo);
      const cross = new THREE.Group();
      for (let k = 0; k < 2; k++) {
        const f = new THREE.Mesh(fGeo, flameMat);
        f.rotation.y = (k * Math.PI) / 2;
        cross.add(f);
      }
      cross.position.set(candle.position.x, h + 0.018, candle.position.z);
      this.group.add(cross);
      this.flames.push(cross as unknown as THREE.Mesh);
    }

    this.baseY = tallest + 0.06;
    this.light = new THREE.PointLight('#ffb46b', this.baseIntensity, 9, 2);
    this.light.position.set(0, this.baseY, 0);
    this.light.castShadow = false; // scene may enable on quality
    this.group.add(this.light);
  }

  update(dt: number, elapsed: number): void {
    const t = elapsed * 9 + this.phase;
    // Smooth value noise: lerp from sample k toward k+1 as frac rises —
    // weights the right way round or the flicker pops at every integer t.
    const k = Math.floor(t);
    const frac = t - k;
    const fast = flickerNoise(k) * (1 - frac) + flickerNoise(k + 1) * frac;
    const slow = 0.85 + 0.15 * Math.sin(elapsed * 0.7 + this.phase);
    this.light.intensity = this.baseIntensity * (0.78 + 0.32 * fast) * slow;
    this.light.position.x = (fast - 0.5) * 0.012;
    this.light.position.y = this.baseY + (fast - 0.5) * 0.008;
    for (let i = 0; i < this.flames.length; i++) {
      const f = this.flames[i];
      const s = 0.85 + 0.3 * flickerNoise(t + i * 7.3);
      f.scale.set(s, s * (1.05 + 0.25 * fast), s);
      f.rotation.y += dt * (0.6 + i * 0.21);
    }
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}

// ---------------------------------------------------------------------------
// buildCandleFlat
// ---------------------------------------------------------------------------
export interface CandleFlatParams {
  width: number;
  depth: number;
  height?: number;
  doorOffset?: number;
  windowOffsets?: number[];
  seed?: number;
}

export interface CandleFlat {
  group: THREE.Group;
  colliders: InteriorColliderDesc[];
  candles: CandleRig[];
  dispose(): void;
}

export function buildCandleFlat(params: CandleFlatParams): CandleFlat {
  const W = params.width;
  const D = params.depth;
  const H = params.height ?? 2.7;
  const doorOffset = params.doorOffset ?? 0;
  const windowOffsets = params.windowOffsets ?? [];
  const seed = params.seed ?? 41;
  const rng = mulberry32(seed);

  const group = new THREE.Group();
  group.name = 'candleFlat';
  const colliders: InteriorColliderDesc[] = [];
  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];

  // ---- materials ----
  const floorMat = new THREE.MeshStandardMaterial({ roughness: 1 });
  applyPBR(floorMat, makeWoodFloor(seed));
  patchWorldMaterial(floorMat, { ashAmount: 0 });

  const wallMat = new THREE.MeshStandardMaterial({ roughness: 1 });
  applyPBR(wallMat, makeInteriorPlaster('#7d7468', seed + 1));
  patchWorldMaterial(wallMat, { ashAmount: 0 });

  const ceilMat = new THREE.MeshStandardMaterial({ roughness: 1 });
  applyPBR(ceilMat, makeInteriorPlaster('#8a8378', seed + 2));
  patchWorldMaterial(ceilMat, { ashAmount: 0 });

  const woodMat = new THREE.MeshStandardMaterial({ color: '#5d4f3e', roughness: 0.75 });
  patchWorldMaterial(woodMat, { ashAmount: 0 });

  const clothMat = new THREE.MeshPhysicalMaterial({
    color: '#4f5358',
    roughness: 0.95,
    sheen: 0.3,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color('#9aa0a4'),
  });
  patchWorldMaterial(clothMat, { ashAmount: 0 });

  const darkMat = new THREE.MeshStandardMaterial({ color: '#1a1d22', roughness: 0.9 });
  patchWorldMaterial(darkMat, { ashAmount: 0 });

  const metalMat = new THREE.MeshStandardMaterial({ color: '#4e5154', roughness: 0.45, metalness: 0.7 });
  patchWorldMaterial(metalMat, { ashAmount: 0 });

  // Daylight seam at a blacked-out window edge: the grey day is OUT THERE.
  const seamMat = new THREE.MeshStandardMaterial({
    color: '#0b0c0e',
    emissive: '#aeb6bf',
    emissiveIntensity: 1.6,
  });
  patchWorldMaterial(seamMat, { ashAmount: 0 });
  ownedMats.push(floorMat, wallMat, ceilMat, woodMat, clothMat, darkMat, metalMat, seamMat);

  const add = (mesh: THREE.Mesh, cast = true): THREE.Mesh => {
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    ownedGeos.push(g);
    return g;
  };

  // ---- shell ----
  const floor = new THREE.Mesh(track(uvPlane(W, D, 2)), floorMat);
  floor.rotation.x = -Math.PI / 2;
  add(floor, false);

  const ceil = new THREE.Mesh(track(uvPlane(W, D, 3)), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = H;
  add(ceil, false);

  // Side walls (local ±X) and back wall (−Z), facing inward.
  const sideGeo = track(uvPlane(D, H, 3));
  const wallL = new THREE.Mesh(sideGeo, wallMat);
  wallL.rotation.y = Math.PI / 2;
  wallL.position.set(-W / 2, H / 2, 0);
  add(wallL, false);
  const wallR = new THREE.Mesh(sideGeo, wallMat);
  wallR.rotation.y = -Math.PI / 2;
  wallR.position.set(W / 2, H / 2, 0);
  add(wallR, false);
  const back = new THREE.Mesh(track(uvPlane(W, H, 3)), wallMat);
  back.position.set(0, H / 2, -D / 2);
  add(back, false);
  colliders.push(
    { cx: -W / 2, cz: 0, hx: WALL_T, hz: D / 2, yaw: 0 },
    { cx: W / 2, cz: 0, hx: WALL_T, hz: D / 2, yaw: 0 },
    { cx: 0, cz: -D / 2, hx: W / 2, hz: WALL_T, yaw: 0 },
  );

  // Door wall (+Z): two segments flanking the doorway + lintel above it.
  const doorL = doorOffset - DOOR_W / 2; // local x of door left edge
  const doorR = doorOffset + DOOR_W / 2;
  const segLW = doorL - -W / 2;
  const segRW = W / 2 - doorR;
  const doorWallGeos: THREE.BufferGeometry[] = [];
  if (segLW > 0.01) {
    doorWallGeos.push(
      uvPlane(segLW, H, 3)
        .rotateY(Math.PI)
        .translate(-W / 2 + segLW / 2, H / 2, D / 2),
    );
    colliders.push({ cx: -W / 2 + segLW / 2, cz: D / 2, hx: segLW / 2, hz: WALL_T, yaw: 0 });
  }
  if (segRW > 0.01) {
    doorWallGeos.push(
      uvPlane(segRW, H, 3)
        .rotateY(Math.PI)
        .translate(W / 2 - segRW / 2, H / 2, D / 2),
    );
    colliders.push({ cx: W / 2 - segRW / 2, cz: D / 2, hx: segRW / 2, hz: WALL_T, yaw: 0 });
  }
  doorWallGeos.push(
    uvPlane(DOOR_W, H - DOOR_H, 3)
      .rotateY(Math.PI)
      .translate(doorOffset, DOOR_H + (H - DOOR_H) / 2, D / 2),
  );
  const doorWall = new THREE.Mesh(track(mergeGeometries(doorWallGeos)), wallMat);
  for (const g of doorWallGeos) g.dispose();
  add(doorWall, false);

  // Door casing frame.
  const casingGeos = [
    new THREE.BoxGeometry(0.08, DOOR_H + 0.08, 0.14).translate(doorL - 0.04, DOOR_H / 2, D / 2),
    new THREE.BoxGeometry(0.08, DOOR_H + 0.08, 0.14).translate(doorR + 0.04, DOOR_H / 2, D / 2),
    new THREE.BoxGeometry(DOOR_W + 0.16, 0.08, 0.14).translate(doorOffset, DOOR_H + 0.04, D / 2),
  ];
  const casing = new THREE.Mesh(track(mergeGeometries(casingGeos)), woodMat);
  for (const g of casingGeos) g.dispose();
  add(casing);

  // Blacked-out windows on the door wall: casing + near-black pane; one gets
  // a thin emissive daylight seam down one edge.
  const winW = 1.2;
  const winH = 1.5;
  const winY = 1.05 + winH / 2;
  windowOffsets.forEach((off, i) => {
    const paneGeo = track(new THREE.PlaneGeometry(winW, winH).rotateY(Math.PI));
    const pane = new THREE.Mesh(paneGeo, darkMat);
    pane.position.set(off, winY, D / 2 - 0.02);
    add(pane, false);
    const frameGeos = [
      new THREE.BoxGeometry(0.06, winH + 0.12, 0.1).translate(off - winW / 2 - 0.03, winY, D / 2 - 0.04),
      new THREE.BoxGeometry(0.06, winH + 0.12, 0.1).translate(off + winW / 2 + 0.03, winY, D / 2 - 0.04),
      new THREE.BoxGeometry(winW + 0.12, 0.06, 0.1).translate(off, winY + winH / 2 + 0.03, D / 2 - 0.04),
      new THREE.BoxGeometry(winW + 0.12, 0.06, 0.1).translate(off, winY - winH / 2 - 0.03, D / 2 - 0.04),
    ];
    const frame = new THREE.Mesh(track(mergeGeometries(frameGeos)), woodMat);
    for (const g of frameGeos) g.dispose();
    add(frame);
    if (i === 0) {
      const seam = new THREE.Mesh(track(new THREE.PlaneGeometry(0.02, winH).rotateY(Math.PI)), seamMat);
      seam.position.set(off - winW / 2 + 0.02, winY, D / 2 - 0.015);
      add(seam, false);
    }
  });

  // ---- furniture (seeded misalignment — nothing showroom-straight) ----
  const woodGeos: THREE.BufferGeometry[] = [];
  const placeAngle = (): number => (rng() - 0.5) * 0.16;

  // Dining table, centre-left.
  const tableX = -W * 0.12;
  const tableZ = -D * 0.08;
  const tableYaw = placeAngle();
  {
    const top = new THREE.BoxGeometry(1.4, 0.04, 0.8).translate(0, 0.74, 0);
    const legGeo = (lx: number, lz: number): THREE.BufferGeometry =>
      new THREE.BoxGeometry(0.06, 0.72, 0.06).translate(lx, 0.36, lz);
    const t = mergeGeometries([top, legGeo(-0.62, -0.32), legGeo(0.62, -0.32), legGeo(-0.62, 0.32), legGeo(0.62, 0.32)]);
    top.dispose();
    t.rotateY(tableYaw);
    t.translate(tableX, 0, tableZ);
    woodGeos.push(t);
    colliders.push({ cx: tableX, cz: tableZ, hx: 0.72, hz: 0.42, yaw: tableYaw });
  }

  // Two chairs, one pulled out and angled.
  const chairGeo = (cx: number, cz: number, yaw: number): void => {
    const seat = new THREE.BoxGeometry(0.42, 0.04, 0.4).translate(0, 0.45, 0);
    const backrest = new THREE.BoxGeometry(0.42, 0.5, 0.04).translate(0, 0.72, -0.18);
    const leg = (lx: number, lz: number): THREE.BufferGeometry =>
      new THREE.BoxGeometry(0.04, 0.44, 0.04).translate(lx, 0.22, lz);
    const c = mergeGeometries([seat, backrest, leg(-0.17, -0.16), leg(0.17, -0.16), leg(-0.17, 0.16), leg(0.17, 0.16)]);
    seat.dispose();
    backrest.dispose();
    c.rotateY(yaw);
    c.translate(cx, 0, cz);
    woodGeos.push(c);
  };
  chairGeo(tableX - 0.2, tableZ + 0.75, Math.PI + placeAngle());
  chairGeo(tableX + 0.75, tableZ - 0.4, -Math.PI / 2 + 0.5 + placeAngle());

  // Bookshelf along the back wall.
  const shelfX = W * 0.25;
  const shelfZ = -D / 2 + 0.16;
  {
    const side = (lx: number): THREE.BufferGeometry =>
      new THREE.BoxGeometry(0.04, 0.9, 0.28).translate(lx, 0.45, 0);
    const board = (ly: number): THREE.BufferGeometry =>
      new THREE.BoxGeometry(1.8, 0.03, 0.28).translate(0, ly, 0);
    const s = mergeGeometries([side(-0.88), side(0.88), board(0.02), board(0.32), board(0.62), board(0.9)]);
    s.translate(shelfX, 0, shelfZ);
    woodGeos.push(s);
    colliders.push({ cx: shelfX, cz: shelfZ, hx: 0.92, hz: 0.16, yaw: 0 });
  }

  // Kitchen counter strip along the left wall.
  const counterZ = D * 0.18;
  {
    const c = new THREE.BoxGeometry(0.6, 0.9, 2.0).translate(-W / 2 + 0.31, 0.45, counterZ);
    woodGeos.push(c);
    colliders.push({ cx: -W / 2 + 0.31, cz: counterZ, hx: 0.3, hz: 1.0, yaw: 0 });
  }

  // Radio-sized box with knobs on the table — Ellen's bench (set dressing
  // until M3 wires the real radio).
  {
    const radio = new THREE.BoxGeometry(0.42, 0.18, 0.2).translate(tableX + 0.3, 0.74 + 0.11, tableZ);
    woodGeos.push(radio);
  }

  const woodMerged = new THREE.Mesh(track(mergeGeometries(woodGeos)), woodMat);
  for (const g of woodGeos) g.dispose();
  add(woodMerged);

  // Knobs on the radio (metal).
  const knobGeos = [
    new THREE.CylinderGeometry(0.018, 0.018, 0.015, 8).rotateX(Math.PI / 2).translate(tableX + 0.22, 0.9, tableZ + 0.105),
    new THREE.CylinderGeometry(0.018, 0.018, 0.015, 8).rotateX(Math.PI / 2).translate(tableX + 0.38, 0.9, tableZ + 0.105),
    // two pots on the counter
    new THREE.CylinderGeometry(0.1, 0.09, 0.12, 10).translate(-W / 2 + 0.31, 0.96, counterZ - 0.4),
    new THREE.CylinderGeometry(0.08, 0.075, 0.09, 10).translate(-W / 2 + 0.31, 0.945, counterZ + 0.1),
  ];
  const knobs = new THREE.Mesh(track(mergeGeometries(knobGeos)), metalMat);
  for (const g of knobGeos) g.dispose();
  add(knobs);

  // Bed with blanket against the right wall.
  const bedX = W / 2 - 0.55;
  const bedZ = -D * 0.22;
  {
    const frameGeo = track(new THREE.BoxGeometry(1.0, 0.22, 2.0).translate(bedX, 0.11, bedZ));
    add(new THREE.Mesh(frameGeo, woodMat));
    const blanketGeo = track(new THREE.BoxGeometry(0.96, 0.16, 1.96, 2, 1, 3));
    // soft draped feel: sag the top centre slightly
    const pos = blanketGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0.05 && Math.abs(pos.getX(i)) < 0.4) pos.setY(i, pos.getY(i) - 0.03);
    }
    blanketGeo.computeVertexNormals();
    blanketGeo.translate(bedX, 0.3, bedZ);
    add(new THREE.Mesh(blanketGeo, clothMat));
    colliders.push({ cx: bedX, cz: bedZ, hx: 0.52, hz: 1.02, yaw: 0 });
  }

  // Rug under the table.
  const rugGeo = track(new THREE.PlaneGeometry(2.2, 1.6).rotateX(-Math.PI / 2));
  const rugMat = new THREE.MeshPhysicalMaterial({
    color: '#3e3b36',
    roughness: 1,
    sheen: 0.2,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color('#6b6e70'),
  });
  patchWorldMaterial(rugMat, { ashAmount: 0 });
  ownedMats.push(rugMat);
  const rug = new THREE.Mesh(rugGeo, rugMat);
  rug.position.set(tableX, 0.012, tableZ);
  rug.rotation.y = tableYaw * 0.5;
  add(rug, false);

  // ---- candles: cluster on the table + one on the shelf ----
  const candles: CandleRig[] = [];
  const tableRig = new CandleRig(3, seed + 11);
  tableRig.group.position.set(tableX - 0.25, 0.76, tableZ + 0.1);
  group.add(tableRig.group);
  candles.push(tableRig);
  const shelfRig = new CandleRig(1, seed + 23);
  shelfRig.group.position.set(shelfX - 0.4, 0.93, shelfZ);
  group.add(shelfRig.group);
  candles.push(shelfRig);

  return {
    group,
    colliders,
    candles,
    dispose(): void {
      for (const rig of candles) rig.dispose();
      for (const g of ownedGeos) g.dispose();
      for (const m of ownedMats) m.dispose();
    },
  };
}
