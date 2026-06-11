# Task: Tier-B humanoid actor

YOUR FILE: `src/actors/humanoid.ts` (replace the skeleton; contract in its doc comment is frozen).

THE figure the player stares at for 90 minutes (Ellen's back) — build it with care. Segmented joint hierarchy of THREE.Groups (bone pivots) carrying low-poly meshes; merged where rigid.

## Build (params.height total, default 1.72; proportions in fractions of H)

- Hierarchy: group(feet) → hips (0.53H) → spine → chest (0.72H) → neck → head (pivot 0.88H); chest → shoulderL/R (0.82H, ±0.21H… use shoulder width from build) → elbow → wrist(glove); hips → hipL/R (±0.09H) → knee (0.28H) → ankle/boot.
- Meshes (target ≤4.5k tris total): long winter COAT — a lathe/tapered-cylinder torso flaring below the hips into an open hem (the hem is part of the torso mesh, swings with hips, covers the upper legs — this hides knee imperfections and reads as heavy clothing); arm segments as tapered cylinders (8 radial segs); gloved hands as rounded boxes; lower legs + boots (boot = box toe + cylinder shaft); HOOD around the head: open cone/sphere shell with the face cavity in shadow; SCARF: torus-ish band across the lower face; GOGGLE STRIP: dark glossy band (roughness 0.25) where eyes would be — read §5.4: no face. Optional small backpack (params.build > 0.5? no — add `pack?: boolean` extra param if you like, default false).
- Materials: MeshPhysicalMaterial for cloth with sheen ≈ 0.35, sheenRoughness 0.85, sheenColor pale grey (§5.4 fabric sheen), roughness 0.92; patchWorldMaterial: hood/shoulders material ashAmount 0.8, lower coat 0.45, boots 0.3. Goggles: glossy dark, ashAmount 0.1. Per-instance color params (coatColor/hoodColor/scarfColor) with slight seeded jitter so Ellen/Jonas differ.
- Everything castShadow; receiveShadow true.

## Locomotion (the craft is here)

- setLocomotion(speed, yaw): store; group.rotation.y eases toward yaw (≈10 rad/s, shortest arc — copy dampAngle from player.ts or re-implement) with a subtle roll INTO the turn (±2°).
- update(dt, elapsed): gaitPhase += (speed / strideLength) * 2π * dt with strideLength ≈ 0.62·legLength·2 (≈1.25 m at H 1.72) — feet plant without sliding. Blend walkAmount = smoothstep(0.05, 0.5, speed).
- Walk pose (angles scale with walkAmount and a bit with speed): thighs ±26° sin(phase) opposed; knees: flex 35–55° during swing (use max(0, sin(phase+offset)) shaping so the leg is straight at plant); arms swing opposite ±18° with slight elbow bend; hips: lateral sway (rotation.z ±3°) at phase, vertical bob 2/stride (|sin| shaped, amplitude 0.025 m on hips y); chest counter-rotation (y ±4°); forward lean 3°+speed·1.5°; head stabilises (counter-bob ~50%).
- Idle (walkAmount→0): breathing — chest rise/scale 0.3 Hz subtle; weight shift every 5–8 s (hips x offset ±0.02 eased); occasional small head drift if no look-at target.
- lookAt(point): convert to head-local each frame (zero alloc — module scratch), clamp yaw ±60° pitch ±30°, ease at ~6 rad/s; null releases to idle drift.
- ZERO per-frame allocations. All rotations via direct .rotation channel writes (no quaternions needed beyond what eases the group yaw).

VERIFY: tsc clean. integrationNotes: exact pivot heights, stride length used, tris count, and anything the follower/scene must know.
