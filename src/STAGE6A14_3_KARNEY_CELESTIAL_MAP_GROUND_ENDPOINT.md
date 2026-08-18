# Stage 6A-14-3: Karney celestial-map ground endpoint

## Scope

Only the ground endpoint helper used by celestial map rendering was changed.

## Change

`src/cesium/celestialMap.ts` now uses `calculateKarneyDestinationPoint()` for `destinationGroundPoint()` instead of a fixed-radius spherical direct-geodesic formula.

This helper is used when creating ground positions for celestial map tracks/candidates where terrain-clamped positions are unavailable.

## Not changed

- altitude-bearing celestial track helper
- celestial altitude computation
- terrain sampling
- occlusion logic
- transit search
- tripod candidate search
- UI

The remaining fixed Earth radius in `celestialMap.ts` is still used by the separate altitude-bearing Cartesian helper and is intentionally left for the next incremental stage.
