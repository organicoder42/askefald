# Task: props

YOUR FILE: `src/world/props.ts`

Street props (§5.3): the Danish texture of things, all procedural, all instanced. Read the skeleton contract; signatures frozen. Use makeMetalPainted / makePaintedSign from textures.ts (parallel agent — code against skeleton signatures; metal tile ≈ 2 m). patchWorldMaterial everything; up-facing-heavy parts get high ashAmount.

## buildBikeHeap(count, rx, rz, seed)

ONE bike geometry ~300 tris: wheels = 2 × TorusGeometry(0.33, 0.018, 6, 16); frame = cylinders (r 0.02): down tube, top tube, seat tube, chain stays, fork, handlebar (short bent cylinder), saddle (small box), all merged into a single BufferGeometry. ONE InstancedMesh (count), muted near-black metal material (ashAmount 0.9). Transforms: heap = bikes LYING and LEANING jumbled in an ellipse rx×rz — random yaw, roll mostly near ±90° (fallen flat) with stack height rising toward the centre (y = pile envelope * random), slight pitch; seeded RNG for determinism. castShadow true, receiveShadow true.

## buildAbandonedCars(placements, seed)

A generic 90s-hatchback silhouette, low-poly but PROPORTIONED (≈4.2×1.7×1.42 m): body = merged boxes or an ExtrudeGeometry side-profile swept across width — pick the cleaner approach, comment why; include bumpers and side mirrors (tiny boxes); wheel-arch shadow boxes (dark inset) acceptable instead of real cutouts. Wheels: cylinders (r 0.31, w 0.2), dark rubber, ONE shared InstancedMesh for all wheels (4×N). Glass: separate merged geometry (windscreen/side/rear planes), dark glass material (color #101316, roughness 0.15, metalness 0.2, ashAmount 0.25 — windscreens collect SOME ash), ONE InstancedMesh. 3 paint variants (#6a6e71 grey-blue, #5d5a52 olive-grey, #4e545c slate) → per variant ONE InstancedMesh for bodies. Paint material via makeMetalPainted, roughness ~0.5, ashAmount 1.25 (buried bonnets/roofs = hero read). Position per placements (x, z, yaw), settle y so tyres touch ground (0.31 wheel radius), random ±1.5° roll (flat-tyre feel).

## buildLampPosts(positions)

Copenhagen park-style: pole cylinder (r 0.06, h 5.2), gentle curved arm via TorusGeometry arc (r 0.9, tube 0.045, ~100°) rotated to hang over the road, lamp head = small cylinder + cone shade; merged single geometry → ONE InstancedMesh, dark green-black paint (#23282a), ashAmount 0.7 (ash caps on shade tops). Unlit (the city is dead).

## buildRubblePiles(piles, seed)

Chunk = IcosahedronGeometry(1, 0) with vertices randomly displaced ±35% (3 pre-deformed variants merged into a set); ONE InstancedMesh of ~14 chunks per pile across ALL piles: random scale 0.15–0.6 m (flattened y×0.6), packed inside each pile's radius with height envelope, partial burial (y slightly negative); concrete grey #66686a, roughness 0.95, ashAmount 1.5.

## buildPaintedSign(lines, width=2.2)

Two posts (5×5 cm timber, h 1.6 m, slight opposing leans) + plywood board (width × 0.9 m, 18 mm thick) textured by makePaintedSign(lines) on the FRONT face only (use a separate front plane over a plain box if UV-mapping the box is fiddly), weathered timber material elsewhere; board tilted ~4°. castShadow true.

DETERMINISM: all randomness via seeded RNG. Zero per-frame work (props are static). tsc clean for your file. integrationNotes: per-builder draw-call counts and the ground-contact assumptions (y=0 plane).
