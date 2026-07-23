# Stage 6A-14-14: Karney coordinate input validation

## Scope

This stage adds one defensive validation layer to the shared Karney adapter. It does not change valid coordinate calculations, UI, search thresholds, DEM handling, or rendering logic.

## Change

`src/geodesy/karneyGeodesic.ts` now validates geodetic inputs before calling GeographicLib:

- latitude and longitude must be finite numbers;
- latitude must be within `-90` to `90` degrees;
- inverse calculations validate both origin and target;
- direct calculations validate the origin.

Longitude is intentionally not restricted to `-180` to `180` because GeographicLib accepts and normalizes wrapped longitude values.

## Effect

Valid inputs return the same results as before. Invalid coordinates now fail at the shared adapter boundary with a specific error instead of propagating `NaN` or relying on a later result check.

## Verification

- Karney Python reference suite: 4/4 passed.
- JavaScript verification scripts: syntax check passed.
- ZIP integrity: checked after packaging.
- Full Vite production build: not completed because project dependencies are not installed in this execution environment.
