# GSI tier request reduction — 2026-09-09

## Problem
After DEM1A failed to resolve a point, the server started DEM5A, DEM5B, DEM5C and DEM10B for all unresolved points at the same time. This preserved source priority when applying results, but it also guaranteed DEM10B traffic even when one of the 5m DEM sources resolved the point. During continuous bearing-profile downloads this consumed GSI/R2 subrequests and outgoing-connection capacity unnecessarily.

## Change
- DEM1A remains the first authoritative source.
- For DEM1A-unresolved points, DEM5A/DEM5B/DEM5C are requested in parallel.
- Results are applied in the original priority order.
- DEM10B is requested only for points still unresolved after the 5m tier.

## Precision invariants retained
- Source priority: DEM1A -> DEM5A -> DEM5B -> DEM5C -> DEM10B.
- maximumDetail filtering unchanged.
- constrained-bicubic interpolation for 1m requests unchanged.
- neighboring tiles required for 4x4 interpolation unchanged.
- R2 decoded-tile cache path unchanged.
- coordinate generation and geodesic/profile sampling unchanged.

## Verification
- verify-gsi-tier-request-reduction-20260909.mjs: 7/7 PASS
- verify-direct-download-prefetch-isolation-20260909.mjs: 7/7 PASS
- verify-bearing-profile-direct-download-20260909.mjs: PASS
- verify-phase5-4-r2-cache.mjs: PASS
- verify-tripod-neutral-dem-20260823.mjs: PASS
- verify-coordinate-serialization.mjs: PASS
- verify-r2-safety-all-paths-20260824.mjs: 11/11 PASS

## Expected effect
Reduces unnecessary DEM10B fetches in areas where DEM5A/5B/5C already provide authoritative heights. In areas that genuinely require DEM10B, one additional tier boundary remains, so exact elapsed-time improvement depends on coverage and R2 hit rate. No fixed completion time is claimed without device measurement.
