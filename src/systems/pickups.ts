import * as THREE from 'three';
import { patchWorldMaterial } from '../graphics/worldMaterial';
import type { GameState } from './gameState';
import type { Meters } from './meters';
import type { Sfx } from '../audio/sfx';

/**
 * Collectible meter-recovery items (M4): scavenged batteries and mask
 * filters that close the survival loop (BATTERI/FILTRE otherwise only drain).
 * A scene builds a PickupSet, adds specs, and each frame feeds the player
 * position; the nearest item within reach surfaces a Danish prompt and is
 * collected on interact() — applying the gain through Meters (the sole
 * writer of state.meters), playing a cue, and setting a GameState flag so it
 * stays collected across saves and scene re-entry.
 *
 * Chroma is rationed: items read by silhouette + idle bob + the proximity
 * prompt, not by glow (no amber — that is reserved for warnings/the needle).
 */

export type PickupKind = 'battery' | 'filter';

export interface PickupSpec {
  /** Unique within the scene; the persistence flag is pickup.<ns>.<id>. */
  id: string;
  kind: PickupKind;
  x: number;
  z: number;
  /** Rest height of the item's centre (default 0.28). */
  y?: number;
  /** Meter gain 0..1 (default: battery 0.4, filter 0.5). */
  amount?: number;
  /** Prompt override (default per kind, Danish). */
  label?: string;
}

export interface PickupResult {
  kind: PickupKind;
  /** First time this kind has been collected (drives one-time teaching). */
  first: boolean;
}

const REACH = 1.7;
const REACH2 = REACH * REACH;
const DEFAULT_AMOUNT: Record<PickupKind, number> = { battery: 0.4, filter: 0.5 };
const DEFAULT_LABEL: Record<PickupKind, string> = {
  battery: 'E — TAG BATTERI',
  filter: 'E — TAG FILTER',
};
const METER_OF: Record<PickupKind, 'batteri' | 'filtre'> = { battery: 'batteri', filter: 'filtre' };

interface Item {
  spec: PickupSpec;
  flag: string;
  mesh: THREE.Object3D;
  baseY: number;
  phase: number;
  collected: boolean;
}

export class PickupSet {
  /** Add this to the scene graph; PickupSet owns its geometry/material life. */
  readonly group = new THREE.Group();
  private readonly state: GameState;
  private readonly meters: Meters;
  private readonly sfx: Sfx;
  private readonly ns: string;
  private readonly items: Item[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private batteryMat: THREE.MeshStandardMaterial | null = null;
  private batteryCapMat: THREE.MeshStandardMaterial | null = null;
  private filterMat: THREE.MeshStandardMaterial | null = null;
  private filterRimMat: THREE.MeshStandardMaterial | null = null;
  private clock = 0;
  private nearest: Item | null = null;

  constructor(state: GameState, meters: Meters, sfx: Sfx, flagNamespace: string) {
    this.state = state;
    this.meters = meters;
    this.sfx = sfx;
    this.ns = flagNamespace;
    this.group.name = `pickups-${flagNamespace}`;
  }

  /** Register an item; already-collected items (flag set) are skipped. */
  add(spec: PickupSpec): void {
    const flag = `pickup.${this.ns}.${spec.id}`;
    if (this.state.hasFlag(flag)) return;
    const baseY = spec.y ?? 0.28;
    const mesh = spec.kind === 'battery' ? this.buildBattery() : this.buildFilter();
    mesh.position.set(spec.x, baseY, spec.z);
    this.group.add(mesh);
    this.items.push({
      spec,
      flag,
      mesh,
      baseY,
      phase: (spec.x * 1.7 + spec.z * 0.9) % (Math.PI * 2), // deterministic offset
      collected: false,
    });
  }

  /** Per frame: idle bob + find the nearest live item within reach. */
  update(dt: number, x: number, z: number): void {
    this.clock += dt;
    let best: Item | null = null;
    let bestD2 = REACH2;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.collected) continue;
      it.mesh.position.y = it.baseY + Math.sin(this.clock * 1.6 + it.phase) * 0.035;
      it.mesh.rotation.y += dt * 0.6;
      const dx = x - it.spec.x;
      const dz = z - it.spec.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = it;
      }
    }
    this.nearest = best;
  }

  /** Prompt for the nearest in-reach item, or null. */
  get promptText(): string | null {
    if (!this.nearest) return null;
    return this.nearest.spec.label ?? DEFAULT_LABEL[this.nearest.spec.kind];
  }

  /** Collect the nearest in-reach item, or null if none. */
  interact(): PickupResult | null {
    const it = this.nearest;
    if (!it) return null;
    const kind = it.spec.kind;
    this.meters.recover(METER_OF[kind], it.spec.amount ?? DEFAULT_AMOUNT[kind]);
    this.state.setFlag(it.flag);
    const taught = `taught.${kind}`;
    const first = !this.state.hasFlag(taught);
    if (first) this.state.setFlag(taught);
    this.sfx.pickup();
    it.collected = true;
    it.mesh.visible = false;
    this.nearest = null;
    return { kind, first };
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    this.batteryMat?.dispose();
    this.batteryCapMat?.dispose();
    this.filterMat?.dispose();
    this.filterRimMat?.dispose();
    this.geos.length = 0;
    this.items.length = 0;
  }

  // -- meshes (small, low-chroma; shared materials per kind) ---------------

  private buildBattery(): THREE.Object3D {
    if (!this.batteryMat) {
      this.batteryMat = new THREE.MeshStandardMaterial({ color: '#3a4a44', roughness: 0.6, metalness: 0.3 });
      patchWorldMaterial(this.batteryMat, { ashAmount: 0.2 });
      this.batteryCapMat = new THREE.MeshStandardMaterial({ color: '#9a9286', roughness: 0.5, metalness: 0.4 });
      patchWorldMaterial(this.batteryCapMat, { ashAmount: 0.2 });
    }
    const g = new THREE.Group();
    const body = new THREE.BoxGeometry(0.2, 0.12, 0.34);
    const cap = new THREE.BoxGeometry(0.21, 0.05, 0.06).translate(0, 0, 0.17);
    this.geos.push(body, cap);
    const bodyMesh = new THREE.Mesh(body, this.batteryMat!);
    const capMesh = new THREE.Mesh(cap, this.batteryCapMat!);
    bodyMesh.castShadow = true;
    g.add(bodyMesh, capMesh);
    return g;
  }

  private buildFilter(): THREE.Object3D {
    if (!this.filterMat) {
      this.filterMat = new THREE.MeshStandardMaterial({ color: '#5a5650', roughness: 0.85 });
      patchWorldMaterial(this.filterMat, { ashAmount: 0.25 });
      this.filterRimMat = new THREE.MeshStandardMaterial({ color: '#2e2c29', roughness: 0.7, metalness: 0.3 });
      patchWorldMaterial(this.filterRimMat, { ashAmount: 0.2 });
    }
    const g = new THREE.Group();
    const body = new THREE.CylinderGeometry(0.085, 0.085, 0.18, 12).rotateZ(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(0.095, 0.095, 0.03, 12).rotateZ(Math.PI / 2).translate(0.09, 0, 0);
    this.geos.push(body, rim);
    const bodyMesh = new THREE.Mesh(body, this.filterMat!);
    const rimMesh = new THREE.Mesh(rim, this.filterRimMat!);
    bodyMesh.castShadow = true;
    g.add(bodyMesh, rimMesh);
    return g;
  }
}
