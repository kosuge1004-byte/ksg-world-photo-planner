# Stage 6A-10: Karney direct geodesic for tripod candidate generation

## Scope

Only the candidate-point generation inside `src/cesium/tripodCandidates.ts` was changed.

- Before: spherical destination formula using a fixed mean Earth radius
- After: GeographicLib WGS84 `Geodesic.WGS84.Direct`

## Added API

`calculateKarneyDestinationPoint(origin, bearingDegrees, distanceMeters)` was added to `src/geodesy/karneyGeodesic.ts`.

It validates finite inputs, rejects negative distance, normalizes the bearing, and validates the returned latitude and longitude.

## Unchanged

- DEM sampling and terrain heights
- altitude-error calculation
- coarse distance sampling
- root refinement
- celestial-coordinate calculation
- frame and disc containment checks
- celestial occlusion tracing

The output height from the direct geodesic helper is not used as terrain height. Candidate Cartographic points are created at height 0 and are subsequently replaced by sampled terrain heights, preserving the existing flow.

## Verification limitations

The package dependency is declared in `package.json` and `package-lock.json`, but a full npm install/build could not be completed in this environment. No build success is claimed.
