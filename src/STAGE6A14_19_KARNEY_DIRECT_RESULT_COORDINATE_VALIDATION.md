# Stage 6A14-19: Karney direct-result coordinate validation

## Change

The GeographicLib direct-geodesic endpoint is now validated through the shared
`assertValidGeodeticCoordinate()` helper.

This replaces separate finite-number checks for `lat2` and `lon2` and adds the
same latitude-range validation already used for geodesic inputs.

## Scope

- No change to the Karney calculation or valid-result output.
- No UI, search, DEM, terrain-occlusion, or preview behavior changes.
- Invalid GeographicLib endpoint results now fail through the common coordinate
  validation path.

## Audit

A source scan found no remaining runtime fixed-radius or haversine distance
implementation under `src/` or `server/`. The spherical implementation retained
in `scripts/verify-geodesic-comparison.mjs` is verification-only and intentionally
kept to quantify the difference from Karney/WGS84.
