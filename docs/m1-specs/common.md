# ASKEFALD — M1 module agent: common brief

PROJECT: ASKEFALD — a cinematic third-person narrative survival game in Three.js. Denmark after a nuclear winter: permanent November dusk, the sun a pale disc behind overcast ("askesolen"), and ash — falling, drifting, settling on every up-facing surface — as the game's visual signature. You are implementing ONE module of the M1 rendering core, whose verification target is a "look-dev street": a moody, ash-choked Copenhagen street at noon that must genuinely look like a next-gen browser game.

REPO: /Users/thomassaabynoer/Documents/privateProjects/Bunkergame3D
STACK: Vite + TypeScript (strict), three@0.184.0, postprocessing@6.39.1, n8ao@1.10.1, lil-gui@0.21. WebGL2 only. Target 60 fps on M1/GTX1660 at 1080p High.

READ THESE FILES FIRST (existing core you must build on):

- `src/core/engine.ts` — Engine class: WebGLRenderer (AgX tone mapping, SRGB output, PCFSoft shadows), single RAF loop, setRenderFn/onResize/onUpdate hooks.
- `src/core/quality.ts` — QualitySettings presets.
- `src/graphics/palette.ts` — PALETTE tokens, ActLookConfig, ACT_CONFIGS (act1 = the look-dev act), getSunDirection (returns direction of light TRAVEL, sun toward scene).
- `src/graphics/worldMaterial.ts` — THE shared shader system: patchWorldMaterial(mat, {ashAmount}) injects layered fog + ash-settle into Standard/Physical materials via onBeforeCompile; worldUniforms (shared uniform objects: uTime, uFogColor, uFogDensity, uHeightFog*, uFogNoiseAmount, uAshLevel, uAshColor, uAshNoiseScale); ASK_NOISE_GLSL and ASK_FOG_FACTOR_GLSL exported for custom ShaderMaterials that must fog identically.
- The skeleton file(s) you are replacing — they contain the CONTRACT as doc comments and exact exported signatures.

YOUR TASK: Fully implement your assigned file(s), replacing every `throw new Error('not implemented')` body. KEEP ALL EXPORTED SIGNATURES EXACTLY — six other agents are coding against them in parallel right now. You may add private helpers and extra exports, never remove or change existing ones.

HARD RULES:

1. TS strict must pass for YOUR files: run `cd /Users/thomassaabynoer/Documents/privateProjects/Bunkergame3D && npx tsc --noEmit 2>&1 | grep -E '<your file names>'` and iterate until YOUR files produce zero errors. Other files WILL show errors while sibling agents work — ignore anything not in your files.
2. Zero per-frame allocations in update paths — preallocate module-scope scratch vectors/colors.
3. Every world-geometry material goes through patchWorldMaterial() so fog + ash apply. Custom ShaderMaterials (particles) must implement fog with the exported GLSL chunks instead (sky excepted — it IS the backdrop).
4. Albedo/canvas textures: `texture.colorSpace = THREE.SRGBColorSpace`. Roughness/normal/data: leave linear. anisotropy 8, RepeatWrapping where tiling.
5. dispose() frees everything you created: geometries, materials, textures, render targets.
6. Verify three@0.184 / postprocessing@6.39 / n8ao APIs against node_modules type declarations and source when in ANY doubt — do not guess from memory. three addons import path: `three/addons/...` works (package exports map).
7. Shadows: meshes castShadow/receiveShadow as physically sensible. Draw calls are precious: whole scene budget ≤300 calls, ≤1.5M tris — merge static geometry (BufferGeometryUtils.mergeGeometries) per material, use InstancedMesh for repeats.
8. Comments state constraints, not narration. Code/comments in English; any in-world text is Danish.

ART DIRECTION (act1, drives every choice): blue-grey twilight at noon — shadows tinted #5C6B7A, global ash mid-tone #9A9C9B, chroma rationed to near-greyscale (saturation ±8% of grey except candle/fire accents #E8A23C). The askesol sits 8° above the horizon, a soft pale disc you can look directly at. Heavy layered fog dissolves the street at 150–250 m. Everything reads quiet, cold, and heavy. When in doubt between features and beauty, choose beauty.

When done, RETURN structured output: summary, files, deviations, integrationNotes.
