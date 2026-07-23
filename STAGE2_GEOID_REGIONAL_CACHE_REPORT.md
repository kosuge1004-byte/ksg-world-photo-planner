# Stage 2A: Regional geoid correction

## Scope
Only requirement ③ was implemented in this stage. Accuracy settings and refraction remain unchanged for the next stage.

## Changed file
- `src/cesium/worldTerrain.ts`

## Changes
- Replaced the single center-point geoid height applied to all samples.
- Groups GSI elevation samples by an approximately 1 km latitude/longitude grid.
- Fetches one geoid height per region and applies it only to samples in that region.
- Reuses in-flight and completed requests in memory.
- Added IndexedDB persistence with a 180-day maximum age.
- If one region cannot obtain a geoid height, only samples in that region fall back to Cesium World Terrain.
- Abort requests still propagate and stop the operation as intended.

## API load control
- Nearby points in the same 0.01-degree rounded region share one request.
- Repeated searches reuse memory or IndexedDB values.
- The existing 60-second outage backoff remains active.

## Verification
- A direct TypeScript parse/type pass against the modified file reached only the expected missing external `cesium` module error because dependencies are not installed.
- `npm ci` could not complete in the execution environment due to an unavailable package artifact (`@parcel/watcher-wasm`).
- Therefore a full project build is not claimed for this stage.
