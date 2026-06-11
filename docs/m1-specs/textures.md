# Task: procedural textures

YOUR FILE: `src/world/textures.ts`

Tier-B procedural PBR texture library (§6.5) — canvas-generated, cached, disposable. These textures carry the realism of the whole street; spend effort on subtle, photographic value variation (think: wet Copenhagen in November, then desaturated). NO pure flat colours anywhere.

SHARED MACHINERY (private): seeded RNG (mulberry32); CPU value-noise + fBm over ImageData; a makeCanvas(size) helper (document.createElement('canvas')); a height→normal sobel converter (strength param) producing a CanvasTexture left linear (do NOT set SRGB on normal/roughness); a finishTexture(tex, {srgb}) helper applying wrapS/T RepeatWrapping, anisotropy 8, needsUpdate. KEEP a module registry of every texture for disposeAllGeneratedTextures().

TEXTURE RECIPES (1024² for facades/asphalt, 512² ok for the rest; albedo luminances are sRGB-display values, keep them MUTED — Act I lives near greyscale):

- makeAsphalt: base #2e3032 ± large-blotch fBm (±8%), fine speckle grain, sparse hairline cracks (random-walk dark polylines), big irregular patch-repair rectangles slightly darker/smoother, faint worn lane-paint dashes (#7a7a74 at 15% alpha, half-erased); roughness map: 0.88 base, smoother on patches; normal from height (subtle, strength ~0.6).
- makeSidewalk: 60×60 cm concrete slabs grid (4×4 per 2.4 m tile): dark joint lines 2-3 px, per-slab luminance jitter ±6%, corner chips + speckle, occasional slab crack; roughness ~0.85; normal: joints recessed.
- makePlasterFacade(baseColor, seed): tinted stucco — fine noise grain + mid-frequency blotches; VERTICAL GRIME STREAKS falling from random sill-height y-positions (multiply dark, varying length/alpha — classic Copenhagen rain streaking); slight overall darkening toward the top (soot wash) and splash-back darkening at the very bottom 8%; roughness ~0.8 ±0.1; gentle normal grain.
- makeBrickFacade(baseColor, seed): running-bond bricks scaled so the tile maps to ~2 m (≈ 8.7 columns × 36 rows), mortar #6f6b66, per-brick hue/luma jitter (±7%, a few much darker clinkers), edge darkening per brick, soot wash top→down multiply; roughness: mortar rougher than brick; normal: mortar recessed ~strength 0.9.
- makeAshDrift: the settled-ash surface — base #9A9C9B with ultra-fine grain, soft low-frequency wind-ripple ridges (anisotropic: stretched noise along one axis), occasional tiny darker flecks (cinders); roughness 0.97 flat-ish; gentle ripple normal map. This must read as POWDER, not concrete: very low contrast, soft.
- makeMetalPainted(color, seed): muted paint base, subtle orange-peel noise, scratches (thin lighter polylines), grime accumulation gradient bottom-up, faint rust speckle at edges (#5a4538 at low alpha); roughness 0.45 base with scratch/grime variation; light normal.
- makePaintedSign(lines, opts): plywood base ~#8a7a5e with wood-grain streak noise + weathering; text painted in dark charcoal (#26262a) uppercase, font '700 Xpx "Arial Narrow", Arial, sans-serif' sized to fit width with jitter per character (rotation ±2°, y ±2 px, per-char alpha 0.85–1) for a hand-painted feel; a few paint drips (short vertical strokes below random letters); supports æ/ø/å (canvas Unicode just works — test by drawing 'GÅ'). SRGB albedo only (single Texture return — no PBR set).
- disposeAllGeneratedTextures(): dispose + clear registry.

DETERMINISM: same seed → same texture (all randomness through the seeded RNG).
VERIFY: tsc clean for your file. integrationNotes: tile sizes in metres for each set (so kit-builders set repeat correctly: asphalt tile ≈ 6 m, sidewalk ≈ 2.4 m, plaster ≈ 4 m, brick ≈ 2 m, ash ≈ 3 m, metal ≈ 2 m).
