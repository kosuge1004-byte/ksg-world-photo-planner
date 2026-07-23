# Stage 6A-14-17: Karney result validation unification

## Scope

Only `src/geodesy/karneyGeodesic.ts` was changed.

## Change

GeographicLib result validation now reuses the existing `assertFiniteNumber()` helper for:

- inverse distance (`s12`)
- inverse initial bearing (`azi1`)
- direct destination latitude (`lat2`)
- direct destination longitude (`lon2`)

This replaces two combined `Number.isFinite()` conditions. Valid calculations are unchanged. Invalid results now identify the exact returned field.

## Unchanged

- geodesic formulas and masks
- UI
- search algorithms
- DEM and terrain occlusion
- camera and foreground calculations

## Verification

- Python GeographicLib reference cases: passed
- JavaScript verification script syntax: passed
- package JSON parsing: passed
- ZIP integrity: checked after packaging
- full build: not run because project dependencies are not installed in this environment
