# Stage 6A-14-1: Legacy spherical calculation isolation

## Scope

This stage makes one small cleanup only.

- Removed the legacy spherical distance/bearing export from `src/cesium/geometry.ts`.
- Kept the old formula only as a private helper inside `src/geodesy/compareGeodesic.ts`.
- Production code can no longer import the legacy spherical line-metrics function.
- Elevation-angle ECEF calculation remains unchanged.

## Runtime effect

None expected. The old spherical formula was only referenced by the Karney comparison utility.
The application runtime paths already use Karney calculations for distance and bearing.

## Not changed

- Search algorithms
- UI
- DEM
- Refraction
- Cesium ECEF elevation calculations
- Occlusion thresholds
