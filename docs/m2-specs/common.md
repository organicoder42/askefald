# ASKEFALD — M2 module agent: common brief

PROJECT: ASKEFALD — cinematic third-person narrative survival game in Three.js (see docs/m1-specs/common.md for the world brief — read it). M1 delivered the rendering core and the look-dev street. M2 makes it PLAYABLE: third-person Ellen with Jonas + Birk followers walking the Act I street, with collision, a candle interior, and exposure adaptation.

REPO: /Users/thomassaabynoer/Documents/privateProjects/Bunkergame3D
STACK: unchanged (three@0.184, TS strict, postprocessing 6.39). Dev server may be running; do not start/stop it.

READ FIRST (M2 core, already implemented — build on these):
- `src/world/collision.ts` — ColliderWorld: addBox(cx,cz,hx,hz,yaw,yMin,yMax), addHeightFn, heightAt(x,z), resolveCircle(pos,r,y) (2D circle vs yawed boxes + sampled ground height).
- `src/actors/player.ts` — PlayerController (Ellen): WASD/orbit camera/collision; READ ITS CONVENTIONS.
- `src/core/sceneManager.ts` — GameScene interface (load/update/dispose).
- `src/world/interiorKit.ts`, `src/actors/{humanoid,dog,follower}.ts`, `src/scenes/act1_city.ts` — the skeleton CONTRACTS (doc comments are binding).
- M1 modules you may reuse: `src/scenes/lookdev.ts` (street composition reference), `src/world/{cityKit,props,textures}.ts`, `src/graphics/{palette,worldMaterial,sky,lights,ashParticles,post}.ts`.

CRITICAL CONVENTION — YAW: facing = (sin(yaw), 0, cos(yaw)). Spawn heading π faces −Z (down-street). Actor groups face local +Z; group.rotation.y = yaw produces the world facing above. Get this right or characters moonwalk.

HARD RULES (same as M1): TS strict zero errors for YOUR files (`npx tsc --noEmit 2>&1 | grep <yourfile>`; ignore sibling files mid-flight); ZERO per-frame allocations in update paths (module-scope scratch); every material through patchWorldMaterial (people collect ash too); dispose() frees everything; verify three r184 APIs against node_modules; draw calls precious (whole act1 scene ≤300 incl. companions + interior); comments state constraints, in-world text Danish.

CHARACTER ART DIRECTION (§5.4): everyone wears hoods, scarves and dust masks/goggles — NO faces, no facial animation. Acting is body language + head look-at. Cloth near-greyscale (coat tones #4a4d4f / #565349 / #5a5550), warm nothing. Ash dusts shoulders, hoods, Birk's back (patchWorldMaterial ashAmount ≈ 0.5–0.8). Bodies mid-poly but DELIBERATE — silhouettes must read as worn, layered winter clothing, not mannequins. Foot-slide is the failure to fight: gait phase advances with distance travelled, not time.

RETURN structured output: summary, files, deviations, integrationNotes.
