# Stage 6A-14-6: Server terrain profile Karney migration

## Scope

Changed only `server/celestialTerrainVisibility.ts`.

The server-side terrain horizon profile previously generated sample coordinates with a fixed mean Earth radius and spherical direct-geodesic formula. It now calls the shared WGS84 Karney direct-geodesic adapter:

- `calculateKarneyDestinationPoint()`
- `Geodesic.WGS84.Direct`

## Preserved behavior

- 160 km maximum terrain search distance
- 112 logarithmic coarse samples
- 48 refined samples
- DEM sampling
- ECEF elevation-angle calculation
- cache key and clearance threshold
- API result structure

## Verification

- Removed the fixed `EARTH_RADIUS_METERS` constant from the server module.
- Removed the server module's hand-written spherical destination formula.
- Confirmed both coarse and refined server profiles call the Karney-backed helper.
- ZIP integrity checked after packaging.
- Full production build was not run because installed dependencies are unavailable in this environment.
