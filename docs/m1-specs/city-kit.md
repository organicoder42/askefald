# Task: city kit

YOUR FILE: `src/world/cityKit.ts`

Procedural Copenhagen façade kit (§6.6) — the walls of the look-dev street. Recognisably Danish: 5-storey perimeter-block architecture, regular window grids, plinth + cornice + mansard roof, drainpipes. Read the skeleton contract carefully; signatures frozen.

USE: textures.ts API (makePlasterFacade / makeBrickFacade / makeSidewalk / makeAsphalt / makeAshDrift — being implemented in parallel; code against the skeleton signatures; tile sizes: asphalt 6 m, sidewalk 2.4 m, plaster 4 m, brick 2 m, ash 3 m). patchWorldMaterial for every material: walls ashAmount 0.3 (vertical, collects little), sills/cornice/roof 1.3–1.6, glass 0.08, ground/sidewalk 1.1, drift mounds 1.8. BufferGeometryUtils.mergeGeometries from 'three/addons/utils/BufferGeometryUtils.js'.

## buildFacadeBlock(params)

- Dimensions: bay width 3.0 m → width = bays*3; floor height 3.1 m; plinth 0.7 m (darker painted band); total wall height = plinth + floors*3.1; cornice ledge (0.25 m deep box strip) above top floor; mansard roof: sloped prism ~2.6 m tall, slope ~70°, slightly inset, with 2-3 dormer boxes; depth of building body 12 m. FRONT FACES LOCAL +Z per contract (front wall plane at local z = +depth/2).
- Window grid: per bay per floor one window 1.25 m wide × 1.7 m tall, sill at +0.9 m above floor line; ground floor: taller openings if shopfront (2.6 m, wider) else windows like above. For each window: dark glass plane inset 0.18 m (MeshStandardMaterial color #14171a, roughness 0.18, metalness 0.25, envMapIntensity 1.2 — patched, ashAmount 0.08), white-grey painted frame: thin boxes (casing border + 1 vertical + 1 horizontal mullion) — BUILD ONE window-unit geometry then translate-merge per window into ONE merged geometry per material (frames together, glass together). Sills: small ledge boxes under each window with OWN material, ashAmount 1.5 (snow-like ash caps on every sill = signature read).
- Shopfront (if params.shopfront): ground floor gets wide dark openings, some boarded with plywood planks (wood-ish flat material), one with a bare awning frame (metal bars).
- Wall: front face + two side faces + simple back, with façade texture; UVs scaled so texture tile = 4 m (plaster) / 2 m (brick). Plinth band: separate darker material strip.
- Drainpipes: 2 thin cylinders (r 0.05) down the façade at bay seams, merged into the frames merge.
- litWindows: choose N window positions; add small emissive planes just behind glass (MeshStandardMaterial, color #1a1107, emissive #d8973f, emissiveIntensity ~1.0) — ONE mesh merging all lit-window planes per block, one material per block (all its candles flicker together with a per-block phase: store in group.userData.flickerPhase). Mats go into group.userData.flickerMats (array).
- Final block = Group with ≤7 meshes (wall, plinth, frames+pipes, glass, sills, roof+cornice+dormers, candle planes). All castShadow/receiveShadow true except glass/candles cast=false.

## buildStreetGround(length, roadWidth, sidewalkWidth)

- Road: plane (along Z, centred x=0), asphalt set, UV repeat length/6 × roadWidth/6; receiveShadow.
- Curbs: low boxes (0.13 m high, 0.3 wide) both sides, granite-grey material.
- Sidewalks: planes at +0.13 m, sidewalk texture 2.4 m tile.
- Ash drifts: 2 long strips (gutter line, x ≈ ±(roadWidth/2 − 0.4)) + strips against the building line (x ≈ ±(roadWidth/2 + sidewalkWidth − 0.3)): PlaneGeometry length×1.6 with ~160×6 segments, CPU-displace Y with fBm + envelope so they hump 0–0.4 m (taller against walls), makeAshDrift texture, ashAmount 1.8, receiveShadow; recompute normals after displacement. Merge all drift strips into ONE mesh.
- Total ≤6 meshes.

## buildSkylineCards(distance)

Ring (8–10 clusters, radius ≈ distance, heights up to 25–35 m) of simple dark extruded prisms/boxes as rooftop silhouettes; include 2 verdigris spire cones + 1 dome (muted #5e6f68, almost grey) — Copenhagen skyline hints; ONE merged mesh per material (2 materials max), castShadow false, receiveShadow false; the layered fog will dissolve them — they exist to break the horizon.

## updateCityFlicker(blocks, elapsed)

For each block group, read userData.flickerMats + flickerPhase; emissiveIntensity = 0.85 + 0.45 * cheap deterministic 1D noise at (elapsed*7 + phase) (fract(sin(...)) style), with occasional deeper dips (multiply by a second slower noise); zero allocations.

VERIFY: tsc clean for your file (textures.ts may still be a skeleton while its agent works — contracts only). integrationNotes: how the look-dev scene should orient blocks (front = local +Z), suggested block params for variety (plaster tints: weathered ochre #8a8068, grey-green #767a70, dusty rose #87726a — all near-grey; brick #6e5d52), and your draw-call count per block.
