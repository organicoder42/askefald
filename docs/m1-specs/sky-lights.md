# Task: sky + lights

YOUR FILES: `src/graphics/sky.ts` and `src/graphics/lights.ts`

## SKY (sky.ts — SkySystem)

- Geometry: SphereGeometry(radius ~850, 48, 24), THREE.BackSide ShaderMaterial, depthWrite:false, frustumCulled:false, renderOrder:-1000. Mesh recentred on camera is NOT needed (caller keeps camera near origin in look-dev); but make the dome huge enough.
- Fragment shader: (a) vertical gradient zenithColor→horizonColor with a pow(~1.6) curve on normalized view-dir Y, blending to groundColor below the horizon with a soft band; (b) pale sun disc: sunDot = dot(viewDir, -sunDir) (sunDir uniform = light travel direction, so disc sits at -sunDir); disc via smoothstep(cos(discRadius), cos(discRadius*0.7), sunDot) at LOW contrast — it must be a disc you can look at, luminance ~2-3x sky, NOT a blown highlight; (c) mie-style glow: pow(max(sunDot,0), ~64..256 scaled by sunGlow) * sunDiscColor * modest factor, plus a broad pow(...,8) haze term; (d) overcast cloud noise: 3-octave value noise (implement in GLSL) on a plane projection of the view ray (e.g. dir.xz/max(dir.y,0.08) * cloudScale * small), scrolling VERY slowly with uTime (one drift cycle ≈ minutes), modulating sky luminance ±~12% * cloudAmount, slightly darkening toward zenith for heavy overcast; (e) hash dithering (+noise * 1.5/255) to kill gradient banding. Output HDR-ish linear values (>1 allowed near sun) — tone mapping happens downstream.
- applyConfig(sky, sunDir): copy SkyConfig colors (THREE.Color .set — hex strings are auto-converted to linear working space) and params into uniforms; store sunDir (normalize, copy into uniform; disc position = -sunDir).
- update(dt, elapsed): advance the material's own uTime uniform only.
- buildEnvironment(renderer): bake current sky into IBL: create a throwaway Scene containing a second mesh sharing THE SAME material (or a clone), use THREE.PMREMGenerator fromScene (check signature in @types/three for r184; pass sigma ≈ 0.04, near/far that fit the dome — you may use a SMALLER dome (radius ~100) dedicated to the bake to fit PMREM's cube camera comfortably). Return pmrem texture; dispose the PMREMGenerator and any temp scene objects before returning. Caller assigns scene.environment and disposes the previous texture. Must be callable repeatedly (act changes, GUI re-bake).
- dispose(): geometry + material.

## LIGHTS (lights.ts — SunRig)

- Build in constructor (no throw): sun = DirectionalLight, castShadow true, shadow.mapSize = shadowMapSize, PCFSoft is already set renderer-side. Tight ortho frustum: left/right/top/bottom ±42 m, near 1, far 400. shadow.bias ≈ -0.0002, shadow.normalBias ≈ 0.6 — STATE in a comment these are tuned against ash-shader acne on flat ground at 8° grazing sun; expose both as public fields for GUI tuning. Sun light position = target - sunDir * 180, light.target positioned at the follow target — both sun and sun.target go in `group`.
- hemi = HemisphereLight in group.
- applyConfig(cfg: ActLookConfig): set colors/intensities from cfg.sun/cfg.hemi; recompute this.sunDir via getSunDirection(cfg.sun, this.sunDir) — note the contract: sunDir is direction OF TRAVEL (from sun toward scene). Reposition light.
- followTarget(p): recenter sun position/target on p BUT snap the target to the shadow-map texel grid to prevent edge shimmer: texelSize = (2*42)/mapSize; project p into light space (use a cached Matrix4 looking down sunDir), snap x/y to texelSize multiples, transform back. Module-scope scratch Vector3/Matrix4 — zero allocations.
- setShadowMapSize(px): set mapSize, dispose shadow.map (set null) so it re-allocates.
- dispose(): dispose shadow map.

VERIFY: tsc clean for both files. In integrationNotes, state exact PMREM usage and anything the look-dev scene must do (e.g. scene.environmentIntensity suggestion ~0.4-0.6 so IBL stays subtle under heavy fog).
