# Stage 6A-14-12: Karney inverse calculation unification

## Change

`calculateKarneyLineMetrics()` now reuses `calculateKarneySurfaceMetrics()` instead of calling `Geodesic.WGS84.Inverse()` independently.

## Effect

- One shared inverse-geodesic validation path
- One shared bearing normalization path
- No change to returned distance, bearing, or height difference
- No UI, search-condition, DEM, or occlusion logic changes
