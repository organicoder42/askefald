# Task: look-dev scene + debug GUI

YOUR FILES: `src/scenes/lookdev.ts` and `src/debug/gui.ts`

You compose the M1 verification scene — the shot that defines the game. Read the skeleton contracts (signatures frozen) and EVERY sibling skeleton you consume: sky.ts, lights.ts, ashParticles.ts, cityKit.ts, props.ts, textures.ts, post.ts (for gui typing), palette.ts, worldMaterial.ts, core/engine.ts, core/quality.ts. Code against those contracts exactly — the implementations are being written in parallel.

## COMPOSITION (street along Z; camera will spawn at (1.2, 1.7, 28) looking toward -Z — main.ts handles the camera, you build the world)

- applyActConfig helper (local): write ACT_CONFIGS.act1 values into worldUniforms (fog color/density/height params/noise, uAshLevel) and set engine.scene.background = null (sky dome covers it). Call during build.
- SkySystem: build, applyConfig(act1.sky, sunDir from getSunDirection(act1.sun)), add mesh; scene.environment = sky.buildEnvironment(engine.renderer); set engine.scene.environmentIntensity ≈ 0.5 (verify the property exists on Scene in three@0.184 — it does; keep IBL subtle under fog).
- SunRig: build (shadowMapSize from qualityManager.current), applyConfig(act1), add group.
- STREET: buildStreetGround(220, 11, 4.5), street runs along Z.
- FAÇADES: building line at x = ±10 (road 11 wide → curb ~5.5, sidewalk to 10). Blocks' FRONT FACE (local +Z) must face the street: local +Z must point toward world +X on the LEFT side (x<0) and toward world −X on the RIGHT side — derive the rotateY angles yourself and double-check the math in a comment. Position so the front plane sits AT the building line (account for body depth 12: centre at x = ±(10 + 6)). 3 blocks per side with ≈2.5 m alley gaps, varying params: bays 7–10, floors 5, mix plaster tints (#8a8068 ochre, #767a70 grey-green, #87726a dusty rose) and one brick (#6e5d52) per side, shopfront true on 2 blocks, litWindows 2–3 on the two blocks nearest the camera (z near +10..+30), distinct seeds. Stagger block lengths so seams don't align across the street. Add one more pair beyond z < −110 with litWindows 0 (they'll be mostly fog).
- CARS: a loose abandoned queue heading OUT of the city (toward −Z): ~9 cars in the right lane (x ≈ +2.6), z from +18 to −95, spaced 9–14 m with jitter, yaw ≈ π (nose −Z) ±0.06, two slewed at angles (yaw ±0.5), one ON the left lane facing +Z (came the other way); variants cycled.
- BIKE HEAPS: one big (38 bikes, rx 3, rz 1.8) on the left sidewalk at (−8, z≈10); a smaller (12 bikes) at (+8.2, z≈−30).
- LAMP POSTS: both sides x = ±9.6, every 24 m, z from +40 to −150, arms hanging over the road (rotate per side).
- SIGN: buildPaintedSign(['DER ER IKKE MERE', 'GÅ MOD ROSKILDE']) on the right sidewalk at (8, 0, 2), angled ≈ −0.4 rad to face up-street toward the camera.
- RUBBLE: 2–3 piles against façades (e.g. (−9.2, −55, r 1.5, h 0.5)).
- SKYLINE: buildSkylineCards(380).
- ASH PARTICLES: new AshParticles({ count: floor(act1.ash.count * qualityManager.current.particleMultiplier) }); setWind from act1.ash.wind ([x,y,z]); add points to scene.
- GOD-RAYS SOURCE: CircleGeometry(radius 30, 32), MeshBasicMaterial({ color: act1.sky.sunDiscColor, transparent: true, opacity: 0.85, fog: false, depthWrite: false }) — VERIFY what GodRaysEffect expects of its light-source mesh in postprocessing docs/types (toneMapped? opaque?); positioned at −sunDir * 820, facing the camera (lookAt), renderOrder −999 (after sky's −1000), frustumCulled false. Store as godRaysSource.
- update(dt, elapsed, camera): worldUniforms.uTime.value = elapsed; sky.update; ash.update(dt, elapsed, camera); sunRig.followTarget(camera.position); updateCityFlicker(blocks, elapsed); keep godRaysSource glued at camera.position − sunDir*820 and facing the camera — zero allocations (module scratch vectors).
- dispose(): remove + dispose everything incl. scene.environment, call disposeAllGeneratedTextures().

## GUI (gui.ts)

lil-gui (`import GUI from 'lil-gui'`); hidden by default (gui.hide()), toggle on window 'keydown' KeyG (remove listener in teardown). Folders: Fog (uFogColor as hex color, uFogDensity 0–0.02, uHeightFogDensity 0–1, uHeightFogFalloff 0–0.4, uFogNoiseAmount 0–1), Sun (elevationDeg 2–25, azimuthDeg −90–90, intensity 0–6 — writes into a local copy of act1.sun, then sunRig.applyConfig with the modified config AND sky.applyConfig; plus a 'Rebake IBL' button calling sky.buildEnvironment → swap scene.environment + dispose old), Ash (uAshLevel 0–1.2, particle density 0–1.5 → ash.setDensity, storm 0–1 → ash.setStorm), Post (exposure 0.3–2 → post.setExposure(v, true), only if post non-null). Return teardown destroying gui + listener.

VERIFY: tsc clean for both files. integrationNotes: exact main.ts wiring you expect (build scene, create post stack with godRaysSource, engine.setRenderFn, camera spawn (1.2, 1.7, 28) facing −Z, free-cam, per-frame order: scene.update → hud → input.endFrame).
