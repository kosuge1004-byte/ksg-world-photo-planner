# Stage 6A-14-15: Karney height input validation

## Scope

This stage adds finite-number validation for heights used by the shared Karney helpers. No geodesic formulas, UI behavior, search conditions, DEM processing, or occlusion logic were changed.

## Changes

- `calculateKarneyLineMetrics()` now rejects non-finite tripod or subject heights before calculating `heightDifferenceMeters`.
- `calculateKarneyDestinationPoint()` now rejects a non-finite origin height before preserving it in the returned `GroundPoint`.

## Reason

Latitude and longitude were already validated, but a `NaN` or infinite height could still propagate into previews, line metrics, candidate points, or later ECEF calculations. The shared boundary now fails early with a clear error.

## Compatibility

All valid inputs produce the same results as before.
