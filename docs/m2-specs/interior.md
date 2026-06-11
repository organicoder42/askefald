# Task: candle interior kit

YOUR FILES: `src/world/interiorKit.ts` (replace skeleton; contract frozen) and ADD two texture functions to `src/world/textures.ts` (no other agent touches it this round — append, following its existing registry/caching/seeded-RNG conventions, do not modify existing functions):

- `export function makeWoodFloor(seed?: number): PBRSet` — worn plank floor: ~14 cm planks along one axis, per-plank luminance/warm-hue jitter around #6b5b48, joint gaps, sparse knots, scuffed sheen variation in the roughness map (walk paths smoother), gentle normal from plank relief. Tile ≈ 2 m.
- `export function makeInteriorPlaster(baseColor: string, seed?: number): PBRSet` — calmer cousin of the façade plaster: fine grain, very subtle blotch, faint darkening at the bottom (skirting grime) — NO streaks (rain never reaches in here). Tile ≈ 3 m.

## The room (buildCandleFlat)

A Nordvest ground-floor flat living room, day 14 of the blackout — someone LIVES here. Origin at floor centre; doorway in the local +Z wall (offset by params.doorOffset), blacked-out windows per windowOffsets on the same wall.

- Shell: floor (wood), ceiling (plaster, height default 2.7), 4 walls (interior plaster, a muted tint like #7d7468); doorway opening 0.95×2.05 (no door mesh — an open doorway with a simple casing frame); windows: casing + fully blacked-out panes (near-black, faint #1a1d22 — blankets nailed over; one with a thin bright seam of daylight at one edge: a 2 cm emissive sliver #aeb6bf at low intensity, it sells "the grey day is OUT THERE").
- Furniture (boxes with care — proportions right, slight seeded misalignment so nothing is showroom-straight): dining table + 2 chairs (one pulled out, angled); a low bookshelf with book rows (varied-height thin boxes, muted spines); bed/mattress against a wall with a blanket (box with a draped-feel bevel + cloth material sheen); rug under the table (thin plane, dark woven tone); small kitchen counter strip with a couple of pots; candles ON the table (the CandleRig) + one on the shelf. A radio-sized box with dials on the table — Ellen's bench, set dressing only until M3.
- Materials all patchWorldMaterial({ ashAmount: 0 }) — the interior is the one ash-free place. Cloth (blanket, rug) MeshPhysicalMaterial sheen ≈ 0.3.
- Merge aggressively: shell 1 mesh per material; furniture merged by material; target ≤10 draw calls, ≤20k tris for the whole flat.
- colliders[]: LOCAL-space InteriorColliderDesc for the walls (the +Z wall as TWO boxes flanking the doorway gap), table, shelf, bed, counter. Thin walls: half-extent ≈ 0.08.

## CandleRig

- 2–3 candle cylinders (varied heights 6–14 cm, #d8cfc0 wax, melted-top hint via a slight taper), each with a FLAME: two crossed small planes (additive-ish emissive #ffc98a, toneMapped material fine — keep them tiny, 2×4 cm) + ONE shared PointLight per rig: color #ffb46b, intensity 5.5, distance 9, decay 2, castShadow false (the scene may enable on quality).
- update(dt, elapsed): light intensity flicker = base·(0.78 + 0.32·noise(elapsed·9 + phase))·(slower secondary dip noise), light position micro-jitter ±6 mm, flame quads scale-pulse in sync and always yaw toward… nothing fancy: rotate the flame cross slowly so it never aligns flat to a likely view. Zero allocations; deterministic phase per rig from seed.
- dispose(): full cleanup.

VERIFY: tsc clean for both files. integrationNotes: collider list semantics, how the scene should place/rotate the flat against a façade (door wall = local +Z), recommended exposure target indoors (≈1.35) and the trigger-zone size.
