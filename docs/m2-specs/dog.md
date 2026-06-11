# Task: Birk the dog

YOUR FILE: `src/actors/dog.ts` (replace the skeleton; contract frozen).

Birk: grey-muzzled hunting dog (a worn, calm, middle-aged pointer mix). He is the game's danger UI — his EARS and posture must read at a glance.

## Build (shoulder height 0.55 m, length ≈ 0.95 m, ≤2.5k tris)

- Hierarchy: group(feet) → body (chest box-capsule + slightly lower rump, pivot at chest) → neck (raked forward) → head (wedge muzzle, grey-tinted front) → earL/earR (separate bones! flat rounded-triangle meshes, pivot at base) ; body → tail (1–2 segments, pivot at rump); 4 legs: shoulder/hip pivot → knee/hock → narrow lower leg + paw. Front legs straighter, hind legs angled (dog anatomy: hock back).
- Materials: fur MeshStandardMaterial (or Physical w/ sheen 0.2) roughness 0.95, furColor default #6b665e, muzzle/chest patch #9a958c blended via a second small mesh or vertex-ish trick — keep simple: separate muzzle-tip mesh in muzzleColor. patchWorldMaterial ashAmount 0.5 (ash on his back!). castShadow.

## Locomotion

- Walk < 1.1 m/s: lateral-sequence gait, legs 90° offset, modest amplitude (shoulder/hip ±20°), head bobs gently with phase, tail relaxed sway.
- Trot ≥ 1.1 m/s: DIAGONAL pairs in phase (LF+RH / RF+LH), amplitude ±32°, body pitch micro-oscillation 2/stride, slight suspension bob, tail streams a little. Blend walk↔trot over a 0.2 m/s band. gaitPhase from distance (stride ≈ 0.5 m walk, 0.8 m trot) — no paw-slide.
- setLocomotion eases group yaw like the humanoid (dogs turn quicker: 14 rad/s).
- Idle: sniff cycle — head dips toward ground every few seconds, ears half-relaxed, tail occasional wag; subtle breathing (body scale y 1±0.01 at 0.5 Hz).
- alert(target): freeze gait blending into a stiff stance (weight forward), head LOCKED on target (full ears up — both ears rotate forward/up, the signature read), tail straight and still. alert(null) relaxes over ~0.5 s.
- sit()/stand(): rump drops (hind legs fold, body pitches up ~25°, front legs straight), tail curled; used by the follower when waiting long. Smooth 0.4 s transitions.
- ZERO per-frame allocations.

VERIFY: tsc clean. integrationNotes: gait thresholds, what alert/sit look like, anything the follower should call.
