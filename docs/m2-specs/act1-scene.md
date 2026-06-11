# Task: Act I city scene (playable)

YOUR FILE: `src/scenes/act1_city.ts` (replace skeleton; contract frozen — note the Act1CityScene interface exposes `player` and `godRaysSource`).

You assemble the M2 verification target: walk Ellen down the M1 street with Jonas + Birk following, enter a courtyard passage and a candle-lit flat, with full collision and the exposure-adaptation beat. READ `src/scenes/lookdev.ts` first — reuse its composition (street ground, façade rows with the same placement math, cars, bike heaps, lamps, sign, rubble, skyline, sky/sun/ash wiring, god-rays disc glue) but build YOUR OWN scene module (lookdev stays untouched as the tuning scene). Shared placement constants may be copied; comment provenance.

## Layout additions over the M1 street

1. **Gennemgangen (courtyard passage)**: in the LEFT façade row, between block 1 and block 2 (z ≈ +5), replace the alley gap with a 2.6 m-wide, 2.3 m-tall arched passage through the building line into a back COURTYARD (≈ 16×12 m, centred ≈ x −22): plaster walls (3 m, reuse façade textures) enclosing it, ash-drifted ground (height fn +0.13), a bike shed (lean-to roof on posts over a small bike heap — props.buildBikeHeap(8,…)), two waste containers (muted boxes), one dead tree (cheap: tapered cylinder trunk + 4–6 bare branch cylinders, very dark). Collision: passage side walls (yMin −1, yMax 3), arch lintel as a box with yMin 2.3 yMax 3.4 (player walks under), courtyard perimeter.
2. **Candle flat**: behind the RIGHT block's shopfront at z ≈ +6 — buildCandleFlat({ width 6, depth 5, doorOffset 0, windowOffsets [−1.8, 1.8] }), rotated so its door wall (+Z local) faces the STREET (−X world): rotation.y = −π/2 wait — derive it: local +Z must map to world −X → rotation.y = −π/2 maps +Z→(−1,0,0)? Verify with the rotation formula in lookdev.ts comments and state the math in a comment. Position the room so the doorway sits flush in the shopfront opening at x = +10 (room centre ≈ x = 12.5+). The door wall replaces collision there: register the flat's colliders[] transformed by the room's matrix (cos/sin math, no allocations at runtime — do it at build).
3. **Cross street (north T-junction)**: behind the spawn (z +44…+50) the main street meets a cross street running along X: extend with a second buildStreetGround(120, 9, 3.5) rotated π/2 at z = +50, façade rows along its far side (2 blocks left + 2 right of the junction, fronts facing the cross street), and close the main street's north end visually. Keep it cheap — these blocks can have litWindows 0 and no props beyond a couple of cars.
4. Block the SOUTH end (z < −160) with collision so nobody walks into the fog floor edge (invisible box).

## Actors

- Ellen (player): HumanoidActor({ height 1.72, coatColor '#4d5052', hoodColor '#3f4244', scarfColor '#5a4f42', seed 1 }); PlayerController(actor, engine.camera, input, colliders); player.spawn(1.2, 34, π).
- Jonas: HumanoidActor({ height 1.78, build 0.25, coatColor '#565349', hoodColor '#4a473f', scarfColor '#3f4347', seed 2 }) + Follower(offsetBack 1.6, offsetSide −0.7, maxSpeed 3.0, radius 0.3).
- Birk: DogActor({ seed 3 }) + Follower(offsetBack 1.0, offsetSide 1.1, maxSpeed 4.0, radius 0.25). warpToSlot both at spawn.
- Companions' `others` array: pass the two follower positions for separation (each skips itself per the follower contract).

## Collision registry (ColliderWorld)

Building lines: long boxes at |x| ∈ [10, 22] per block span (leave the passage + flat door gaps); cars: one box each (hx 2.15, hz 0.9, the placement yaw); lamp posts (hx/hz 0.12); bike heaps (ellipse → box rx×rz); sign, rubble piles, courtyard, interior (transformed descs), cross-street façades, south cap. Height fns: sidewalk plateau (|x| 5.8→10 ⇒ 0.13 with a smooth 0.25 m curb ramp — use the sstep helper pattern), courtyard 0.13, flat floor 0.13, cross-street sidewalks likewise (rotate the test).

## Scene behaviour

- load(): build everything, apply act1 config (copy lookdev's applyActConfig), scene.environment bake, godRaysSource (same glue), spawn actors.
- update(dt, elapsed): worldUniforms.uTime; player.update; followers (leaderPos = player.position, leaderYaw = player.heading); sky.update; ash.update(…, engine.camera); sunRig.followTarget(player.position); updateCityFlicker; candle rigs; god-rays glue (camera − sunDir·820, lookAt camera); EXPOSURE ZONE: AABB test of player.position against the flat's inner bounds (+0.6 m margin past the threshold) → on ENTER post.setExposure(1.35) / on EXIT post.setExposure(ACT_CONFIGS.act1.exposure) — fire only on state CHANGE (§6.8: the ~2 s lerp does the eyes-adjusting feel).
- Interaction stub: none yet (E lands in M3).
- dispose(): colliders.clear(), every build product disposed (actors too), disposeAllGeneratedTextures(), post.setExposure(act1, immediate true) — leave the engine scene empty.

ZERO per-frame allocations in update. Budgets: ≤300 draw calls, ≤1.5 M tris — log your own ?stats check if you run one.

VERIFY: tsc clean (actors/interior are parallel skeletons — contracts only). integrationNotes: spawn pose, debug keys expected (main.ts already binds F8 free-cam + Digit1/2 scene jump), the exposure values used, anything main.ts must NOT do (e.g. don't also set camera — PlayerController owns it when enabled).
