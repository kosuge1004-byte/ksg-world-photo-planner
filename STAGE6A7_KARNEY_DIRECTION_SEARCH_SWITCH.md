# Stage 6A7 — Karney direction-crossing search switch

## Scope

Only the target azimuth used by the `direction-crossing` celestial transit search was changed from the legacy spherical inverse calculation to the WGS84 Karney inverse calculation.

## Changed

- `src/search/celestialTransitSearch.ts`
  - imports `calculateKarneyLineMetrics`
  - uses its `bearingDegrees` only when `criteria.mode === "direction-crossing"`

## Intentionally unchanged

- in-frame search projection still uses `calculateLineMetrics`
- boundary refinement logic
- celestial horizontal-coordinate calculation
- Cesium camera placement
- tripod candidate search
- foreground overlay

## Verification limits

Static source checks and ZIP integrity were performed. A complete production build was not claimed because the npm dependency could not be installed in this environment.
