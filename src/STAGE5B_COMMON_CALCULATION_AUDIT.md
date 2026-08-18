# Stage 5B Common Calculation Path Audit

## Scope
This stage audits only the shared calculation paths used by:
- direction-crossing search
- in-frame search
- preview camera projection

No UI, weather API, geoid cache, result ordering, or search interval algorithm was changed.

## Finding and correction
The search path already used `calculateElevationAngleDegrees()` from `src/cesium/geometry.ts`, but the preview path in `src/cesium/celestial.ts` retained a duplicate ECEF elevation implementation named `lineOfSightElevationDegrees()`.

The duplicate implementation was removed. The preview now calls the same `calculateElevationAngleDegrees()` function as the in-frame search, passing the lens-center observer height through `observerAtLens()`.

## Confirmed shared paths
- Sensor dimensions: `sensorDimensionsMm()` from `src/cesium/camera.ts`
- Subject bearing: `calculateLineMetrics()` from `src/cesium/geometry.ts`
- Camera elevation: `calculateElevationAngleDegrees()` from `src/cesium/geometry.ts`
- Search celestial coordinates/refraction: `horizontalCoordinatesForSearch()` for both search modes

## Verification
TypeScript syntax transpilation diagnostics:
- `src/cesium/celestial.ts`: 0 errors
- `src/search/celestialTransitSearch.ts`: 0 errors
- `src/cesium/geometry.ts`: 0 errors

A full project build remains unverified because dependencies are not installed in the supplied archive.
