import type * as THREE from 'three';

/**
 * Custom collision (§10.1): no physics engine. The game is flat-ish, so
 * collision is 2D — a moving circle (player/companion capsule footprint)
 * against yaw-rotated boxes in the XZ plane — plus a sampled ground height
 * (road 0, sidewalks +0.13, interior floors, drift humps).
 *
 * Static world: scenes register colliders at load and clear() on dispose.
 * resolveCircle() is called per actor per frame — zero allocations.
 */

interface BoxCollider {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  cos: number;
  sin: number;
  /** Colliders above the actor's head are ignored (gateways, arches). */
  yMin: number;
  yMax: number;
}

export type HeightFn = (x: number, z: number) => number | null;

const _local = { x: 0, z: 0 };

export class ColliderWorld {
  private boxes: BoxCollider[] = [];
  private heightFns: HeightFn[] = [];

  /** Axis half-extents hx/hz around centre (cx,cz), rotated by yaw. */
  addBox(cx: number, cz: number, hx: number, hz: number, yaw = 0, yMin = -1, yMax = 3): void {
    this.boxes.push({ cx, cz, hx, hz, cos: Math.cos(yaw), sin: Math.sin(yaw), yMin, yMax });
  }

  /** Convenience: collider from an object's world position + yaw. */
  addBoxAt(obj: THREE.Object3D, hx: number, hz: number, yaw = 0): void {
    this.addBox(obj.position.x, obj.position.z, hx, hz, yaw);
  }

  /** Ground height provider; first non-null wins over the 0 default… highest wins. */
  addHeightFn(fn: HeightFn): void {
    this.heightFns.push(fn);
  }

  clear(): void {
    this.boxes.length = 0;
    this.heightFns.length = 0;
  }

  /** Highest ground height at (x,z); 0 when no provider claims the point. */
  heightAt(x: number, z: number): number {
    let h = 0;
    const fns = this.heightFns;
    for (let i = 0; i < fns.length; i++) {
      const v = fns[i](x, z);
      if (v !== null && v > h) h = v;
    }
    return h;
  }

  /**
   * Push a circle of radius r at (pos.x, pos.z) out of every box it
   * penetrates (vertical span [y, y+height] must overlap the box).
   * Mutates pos in place; returns true if any contact occurred.
   * Two passes settle corner cases without jitter.
   *
   * Rotation convention (matches three's rotation.y): local→world is
   * w = [[c, s], [−s, c]]·l, so world→local uses the transpose.
   */
  resolveCircle(pos: { x: number; z: number }, r: number, y = 0, height = 1.7): boolean {
    let hit = false;
    const boxes = this.boxes;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (y + height < b.yMin || y > b.yMax) continue;
        // World → box-local (transpose of the local→world rotation).
        const dx = pos.x - b.cx;
        const dz = pos.z - b.cz;
        const lx = dx * b.cos - dz * b.sin;
        const lz = dx * b.sin + dz * b.cos;
        // Closest point on the box to the circle centre.
        const px = Math.max(-b.hx, Math.min(b.hx, lx));
        const pz = Math.max(-b.hz, Math.min(b.hz, lz));
        let nx = lx - px;
        let nz = lz - pz;
        const distSq = nx * nx + nz * nz;
        if (distSq >= r * r) continue;
        hit = true;
        if (distSq > 1e-8) {
          // Outside the box: push along the contact normal.
          const dist = Math.sqrt(distSq);
          const push = (r - dist) / dist;
          nx *= push;
          nz *= push;
        } else {
          // Centre inside the box: exit through the nearest face.
          const exitX = b.hx - Math.abs(lx);
          const exitZ = b.hz - Math.abs(lz);
          if (exitX < exitZ) {
            nx = (lx >= 0 ? 1 : -1) * (exitX + r);
            nz = 0;
          } else {
            nx = 0;
            nz = (lz >= 0 ? 1 : -1) * (exitZ + r);
          }
        }
        // Back to world frame (local→world).
        _local.x = nx * b.cos + nz * b.sin;
        _local.z = -nx * b.sin + nz * b.cos;
        pos.x += _local.x;
        pos.z += _local.z;
      }
    }
    return hit;
  }
}
