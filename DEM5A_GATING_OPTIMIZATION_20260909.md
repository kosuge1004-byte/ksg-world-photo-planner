# AstroSight DEM5A gating optimization — 2026-09-09

## Change
High-precision elevation fallback is now staged:
1. DEM1A
2. DEM5A
3. unresolved points only: DEM5B + DEM5C in parallel
4. unresolved points only: DEM10B

Previously DEM5A/DEM5B/DEM5C were all requested together after DEM1A failed, so areas covered by DEM5A still incurred unnecessary DEM5B/DEM5C R2/GSI work.

## Precision
No source priority, interpolation, geodesy, sampling density, or stored-height selection was changed.

## Verification
- New DEM5A gating test: 6/6 PASS
- Direct download regression: 13/13 PASS
- R2 safety all paths: 11/11 PASS

Full npm build was not rerun in this environment.
