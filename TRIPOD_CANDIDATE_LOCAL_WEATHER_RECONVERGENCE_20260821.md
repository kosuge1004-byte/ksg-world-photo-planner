# Tripod candidate local-weather reconvergence

## Purpose
Keep all existing tripod-candidate precision corrections while fixing the case where automatic atmospheric refraction weather was unavailable before a tripod pin existed or remained tied to an old tripod location.

## Changes
- When automatic refraction correction is enabled and no tripod pin exists, the subject point is used only as the initial weather reference.
- After each terrain-solved tripod candidate is obtained, weather is resolved at that candidate location.
- The celestial horizontal coordinates are recomputed with the candidate-local temperature, surface pressure, and relative humidity context.
- The terrain solution is iterated again using the updated apparent celestial direction, preserving the existing convergence loop.
- The final frame validation uses the latest candidate-local weather context.
- Existing WGS84/ECEF sightline seed, Karney geodesics, 1 m DEM refinement, lens-center height, apparent ground-line correction/refraction, field-of-view validation, and legacy full-search fallback are retained.
- Weather service fallback behavior remains unchanged: unavailable weather falls back to the existing standard atmosphere model rather than inventing values.

## Verification
`node scripts/verify-tripod-candidate-weather-reconvergence.mjs` passes all checks.
TypeScript syntax transpilation passed for the two modified source files.
A full `tsc -b` could not complete because the supplied archive is missing existing dependency type definitions (`vite/client`, `node`, and `@cloudflare/workers-types`). This is an environment/archive dependency issue and not proof of a successful full build.
