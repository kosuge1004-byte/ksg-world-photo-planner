# Stage 6A-13: Karney terrain-occlusion profile points

## Scope

Changed only the geographic destination-point calculation used to create terrain line-of-sight sampling coordinates in `src/cesium/celestialOcclusion.ts`.

## Change

The former fixed mean-Earth-radius spherical forward calculation was replaced with `calculateKarneyDestinationPoint()`, which uses GeographicLib `Geodesic.WGS84.Direct`.

This affects the coordinates sampled along the celestial azimuth for terrain-horizon occlusion checks, up to the existing 160 km profile limit.

## Preserved behavior

- Distance sampling distribution and count
- Azimuth cache quantization
- Terrain provider and height sampling
- Horizon angle calculation in ECEF
- Coarse/refined profile selection
- Building/3D Tiles ray intersection
- Occlusion thresholds and result types

## Verification

- Removed the local mean-Earth-radius constant and spherical destination formula from `celestialOcclusion.ts`.
- Confirmed both coarse and refined profile paths continue through the same `destinationCartographic()` adapter.
- JSON and archive-integrity checks were performed.
- Full production build remains dependent on successful package installation in the target environment.
