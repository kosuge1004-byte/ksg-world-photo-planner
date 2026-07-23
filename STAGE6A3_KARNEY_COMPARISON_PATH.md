# Stage 6A-3: Karney comparison path

## Purpose

Add a verification-only path that compares the existing spherical distance/bearing calculation with the new WGS84 Karney calculation. Production callers remain unchanged.

## Added

- `src/geodesy/compareGeodesic.ts`
  - Returns both results and signed differences.
  - Not imported by production UI/search code.
- `scripts/verify-geodesic-comparison.mjs`
  - Runs four reference cases after dependencies are installed.
  - Checks Karney output against fixed WGS84 reference values.
  - Prints spherical-minus-Karney differences.
- `npm run verify:geodesic`

## Production behavior

No production calculation was switched. `calculateLineMetrics()` remains the active implementation.

## Verification limitation

The current execution environment does not contain the downloaded `geographiclib-geodesic` package, so the runtime comparison command could not be completed here. It is ready to run after `npm ci` succeeds.
