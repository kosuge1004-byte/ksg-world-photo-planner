# Stage 6A-14-4: Karney celestial-map altitude endpoint

## Scope

Only `src/cesium/celestialMap.ts` was changed.

The 2D celestial marker and Milky Way path endpoint generator now uses the
shared WGS84 Karney direct-geodesic helper for horizontal latitude/longitude.
The existing altitude projection remains unchanged:

`origin.height + tan(altitude) * distance`

## Removed

- Local mean-Earth-radius constant (`6_371_008.8 m`)
- Local spherical direct-geodesic formula in `destinationPoint()`

## Unchanged

- 1,500 m display projection distance
- Altitude clamping
- Cesium 3D ray calculation
- Track segmentation
- DEM and occlusion logic
- Search algorithms and UI
