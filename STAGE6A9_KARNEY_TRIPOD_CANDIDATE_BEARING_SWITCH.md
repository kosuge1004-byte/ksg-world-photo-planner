# Stage 6A9 — Karney tripod candidate bearing switch

## Scope

Only the final azimuth validation in `src/cesium/tripodCandidates.ts` was changed.
The bearing from each solved tripod candidate to the subject now uses
`calculateKarneyLineMetrics()` on the WGS84 ellipsoid.

## Unchanged

- Candidate position generation (`destinationCartographic`) remains spherical.
- Distance scanning and root refinement remain unchanged.
- Terrain sampling, elevation-angle calculation, field-of-view checks, and celestial calculations remain unchanged.
- Cesium camera and foreground overlay calculations remain unchanged.

This keeps the behavioral change limited to the final subject-bearing comparison.
