# Stage 6A-14-7: Karney precision-structure distance

## Change

- Added `calculateKarneySurfaceDistanceMeters()` to the shared Karney adapter.
- Replaced the fixed meters-per-degree approximation in `server/precisionStructures.ts`.
- Precision structures are now filtered by WGS84 geodesic surface distance.

## Unchanged

- Default search radius: 1,800 m
- Structure records and elevations
- Rounded distance returned by the API
- OSM local geometry projection
- UI and celestial search logic

## Verification limits

The project dependency tree is not installed in this environment, so a full Vite build was not performed.
