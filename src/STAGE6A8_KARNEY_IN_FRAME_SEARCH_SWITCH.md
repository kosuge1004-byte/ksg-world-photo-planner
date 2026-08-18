# Stage 6A-8: Karney in-frame search bearing switch

## Scope

Only the tripod-to-subject bearing used to construct the focal-length in-frame search projection was changed.

## Change

`src/search/celestialTransitSearch.ts`

- Removed the spherical `calculateLineMetrics()` call from `createFrameProjection()`.
- The frame center azimuth now comes from `calculateKarneyLineMetrics(...).bearingDegrees` on the WGS84 ellipsoid.
- Camera elevation, field-of-view calculation, adaptive sampling, frame boundary refinement, eligibility boundary handling, and closest-time refinement are unchanged.

## Deliberately unchanged

- Cesium 3D camera placement
- tripod candidate search
- foreground/ECEF calculations
- celestial coordinate calculations
- UI behavior

## Verification limitations

A complete production build still requires the declared `geographiclib-geodesic` dependency to be available in the build environment.
