# Stage 6A-6: Karney celestial preview switch

## Scope

Only the celestial preview camera projection path was switched from the previous spherical ground-distance/bearing calculation to the WGS84 Karney inverse calculation.

Changed file:

- `src/cesium/celestial.ts`

## Behavior changed

`cameraProjection()` now uses `calculateKarneyLineMetrics()` for the tripod-to-subject initial bearing used to orient the celestial preview camera.

## Behavior intentionally unchanged

- ECEF elevation calculation
- celestial ephemeris calculation
- transit search
- in-frame search
- Cesium 3D camera placement
- tripod candidate search
- foreground overlay
- UI controls

## Verification limits

The changed TypeScript file was syntax-transpiled successfully. A full application build remains unverified because the execution environment cannot currently install `geographiclib-geodesic` and the other missing dependencies.
