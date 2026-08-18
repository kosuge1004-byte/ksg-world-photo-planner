# Stage 6A-14-11: Karney OSM local projection

## Scope

Only the local east/north coordinates used for OSM way and polygon proximity checks were changed.

## Change

`server/osmSiteContext.ts` previously converted latitude and longitude differences with fixed metres-per-degree constants. It now obtains WGS84 distance and initial bearing through `calculateKarneySurfaceMetrics()` and resolves them into local east/north components.

## Preserved behavior

- point-to-segment projection algorithm
- road-width thresholds
- walking-access thresholds
- restricted-area logic
- Overpass queries and response format
- polygon containment logic

## Validation limits

The project dependency tree is not installed in this environment, so a full Vite build was not performed.
