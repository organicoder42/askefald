# Task: follower steering

YOUR FILE: `src/actors/follower.ts` (replace the skeleton; contract frozen).

Navmesh-free companion steering. Two clients: Jonas (HumanoidActor, offsetBack 1.6, offsetSide −0.7, maxSpeed 3.0, radius 0.3) and Birk (DogActor, offsetBack 1.0, offsetSide +1.1, maxSpeed 4.0, radius 0.25). The feel target: they trail naturally with lag, drift to their slot rather than snap, never vibrate against the leader, and don't kiss walls.

## Steering model (run per update; zero allocations — module scratch vectors)

1. Slot: slotPos = leaderPos − forward(leaderYaw)·offsetBack + right(leaderYaw)·offsetSide, where forward = (sin,0,cos)(yaw), right = (−cos,0,sin)(yaw). SMOOTH the slot itself (ease slot toward the instantaneous slot at ~3 Hz) so leader turns whip the slot less.
2. Arrive: dist = |slotPos − pos|; desiredSpeed = maxSpeed·clamp((dist − 0.25)/1.4, 0, 1); if dist > 7 → catch-up boost ×1.35 (capped at maxSpeed·1.35). Velocity eases toward desired direction·speed with accel ≈ 6 m/s².
3. Separation: for each other follower position closer than (radius+0.45): push away with weight ∝ overlap. Leader proximity too: keep ≥ 0.6 m from leaderPos (don't crowd heels).
4. Integrate pos += vel·dt; colliders.resolveCircle(pos, radius, y); y eases to colliders.heightAt (12 Hz like the player).
5. Drive the actor: actualSpeed = |moved|/dt (cheap: track last pos); heading = atan2(vel.x, vel.z) when speed > 0.15 else ease toward leaderYaw; actor.group.position.set(pos); actor.setLocomotion(actualSpeed, heading); actor.update(dt, elapsed).
6. Idle behaviours: track leader-stationary time (leader moved < 0.05 m this frame?). After idleDelay (default 3 s): if the actor has lookAt → aim at the leader's head (leaderPos + 1.6 y) with occasional wander-off glances (every ~4 s pick: leader 60% / random street point 40%); if the actor has sit (Birk) → sit() after 3× idleDelay, stand() the moment the leader moves.
7. warpToSlot: teleport to slot, zero velocity, snap heading to leaderYaw (used at spawn so nobody walks through walls to reach the start slot).

Numerical care: never normalize zero vectors; clamp dt spikes (already ≤0.1 from engine); all state preallocated in the constructor.

VERIFY: tsc clean (HumanoidActor/DogActor are skeletons being implemented in parallel — code only against FollowableActor + the optional sit/stand/lookAt). integrationNotes: exact construction the scene should use for Jonas + Birk (the option values above), call order, and the `others` array convention.
