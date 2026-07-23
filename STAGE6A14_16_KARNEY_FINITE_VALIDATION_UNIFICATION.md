# Stage 6A-14-16: Karney finite-value validation unification

## Scope

Only the validation code in `src/geodesy/karneyGeodesic.ts` was refactored.
No geodesic formula, search condition, UI behavior, DEM logic, or occlusion logic was changed.

## Change

Added the internal helper `assertFiniteNumber(value, valueName)` and reused it for:

- latitude
- longitude
- tripod height
- subject height
- direct-geodesic origin height
- direct-geodesic bearing
- direct-geodesic distance

This removes duplicated `Number.isFinite()` branches and produces an error message that identifies the exact invalid input.

## Runtime effect

Valid inputs produce the same results as before.
Only invalid-input error reporting is more specific.

## Verification

- Python GeographicLib reference verification: passed all four reference cases.
- JavaScript verification scripts: syntax checked.
- JSON files: parsed successfully.
- ZIP integrity: checked after packaging.
- Full npm build: not run because `node_modules` is not included and dependencies are unavailable in this environment.
