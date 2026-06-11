# Task: ash particles

YOUR FILE: `src/graphics/ashParticles.ts`

The always-on falling-ash system (§6.3) — this sells the whole game. 40k particles baseline (count comes from caller; cap attribute allocation at count, density changes via drawRange only).

IMPLEMENTATION:

- BufferGeometry; attributes: aSeed (vec3, random 0..1 — base position inside unit cube) and aRand (vec4: size 0.5..1.5, rotationPhase, swayPhase, brightness 0.8..1.2). Points + custom ShaderMaterial, transparent, depthWrite:false, depthTest:true, blending: NormalBlending, frustumCulled:false on the Points.
- Uniforms: uTime, uCamPos (vec3), uArea (float, default 70), uFall (fall speed m/s), uWind (vec3), uStorm (0..1), uPixelRatio, uSizeScale; PLUS spread in `worldUniforms` from worldMaterial.ts and prepend ASK_NOISE_GLSL + ASK_FOG_FACTOR_GLSL to the fragment shader so particles fog EXACTLY like the world.
- Vertex shader (wrap-around camera-following volume): basePos = aSeed * uArea; drift = vec3(uWind.x * uTime, -uFall * (1.0 + uStorm * 2.5) * uTime * (0.7 + 0.6 * fract(aSeed.x*7.13)), uWind.z * uTime); plus curl-ish sway: x += sin(uTime*0.8 + aRand.z*6.2831) * (0.35 + uStorm*1.2), z += cos(uTime*0.67 + aRand.z*4.7) * 0.3; storm gusts: fold storm into INSTANTANEOUS offset only (e.g. sway.xz += windDir * uStorm * gustNoise), never into unbounded time-multiplied drift. Final: worldPos = uCamPos + mod(basePos + drift - uCamPos, uArea) - uArea*0.5 (component-wise, so the volume always wraps around the camera). gl_PointSize = aRand.x * uSizeScale * uPixelRatio * (1.0 + uStorm*0.8) * clamp(120.0 / -mvPosition.z, 0.05, 14.0); pass vWorldPos, vViewDist, vRot (rotationPhase + uTime*spin), vBright to fragment.
- Fragment: rotate gl_PointCoord around center by vRot; radial soft falloff alpha (smoothstep 0.5→0.15), slight irregularity via one noise lookup so flakes aren't perfect discs; under storm, anisotropically squash the falloff ellipse (streaking feel). Color: ash flake ~vec3(0.72,0.73,0.72) * vBright in linear space; apply fog: f = askFogFactor(vWorldPos, vViewDist, uCamPos, uTime) — note: `cameraPosition` is auto-declared by three for ShaderMaterial in the VERTEX stage; in the fragment use the uCamPos uniform for clarity; finalColor = mix(flakeColor, uFogColor, f); alpha = baseAlpha (≈0.55) * radial * (1.0 - f*0.85) — flakes dissolve into fog. ALSO fade near camera (vViewDist < 0.8 → alpha→0) to avoid screen-filling flakes.
- update(dt, elapsed, camera): set uTime=elapsed, copy camera world position into uCamPos (zero alloc: .setFromMatrixPosition(camera.matrixWorld)).
- setStorm/setWind/setDensity(multiplier → geometry.setDrawRange(0, floor(count*clamp(mult,0,1.5))) — clamp to allocated count!) and dispose() per contract.
- IMPORTANT three@0.184 raw ShaderMaterial: modelViewMatrix/projectionMatrix/position are auto-declared; verify anything else against three's WebGLProgram source before relying on it.

VERIFY: tsc clean. integrationNotes: tell the integrator to add points to scene, call update each frame, wire act1 wind/fall config, and that density/storm hooks exist for the GUI.
