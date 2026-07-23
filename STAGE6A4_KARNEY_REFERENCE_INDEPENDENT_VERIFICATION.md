# Stage 6A-4: Karney reference independent verification

## Purpose

Independently validate the four WGS84 reference values used by
`scripts/verify-geodesic-comparison.mjs` before switching any production code.

## Added

- `scripts/verify-geodesic-reference-python.py`

The script uses the installed Python GeographicLib implementation as an
independent oracle. It is test-only and is not imported by the web application.

## Result

All four cases passed at the following tolerances:

- distance: `1e-6 m`
- initial bearing: `1e-10 deg`

Cases:

1. short local baseline
2. Nagoya to Tokyo
3. antimeridian crossing
4. near-antipodal path

## Production impact

None. `calculateLineMetrics()` remains unchanged and the application still uses
the existing calculation path.

## Remaining blocker

The JavaScript package `geographiclib-geodesic` could not be downloaded in this
execution environment because npm network access timed out. Therefore the
JavaScript adapter and full application build remain unexecuted here.
