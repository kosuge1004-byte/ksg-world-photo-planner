# Stage 5H: In-frame search boundary audit

## Scope

- Search-window start and end boundaries
- Weekday and midnight transitions
- Search-period exclusive end
- Multiple bodies in the same sample interval
- Display count = 1
- Abort checks during boundary/closest-time refinement

## Finding

In-frame search discarded samples outside the selected weekday/time window and cleared frame state immediately. If the selected window boundary fell between coarse frame samples, the search could not determine the actual overlap between:

1. the interval in which the body was inside the camera frame, and
2. the interval allowed by weekday/time criteria.

This could miss a body entering the frame just after the search start, or choose a closest time outside the allowed interval near the search end.

## Change

- Every coarse frame sample now records both frame inclusion and date/time eligibility.
- Frame-entry/exit boundaries and eligibility-entry/exit boundaries are refined independently to approximately one second.
- The valid in-frame interval is the intersection of both refined intervals.
- Closest-time refinement is clamped to that valid interval.
- The exact exclusive end of the overall search period is sampled as an ineligible terminal boundary, so the final partial sample interval is not lost.
- Final result insertion rechecks full date eligibility.

## Unchanged

- Camera projection and field-of-view calculation
- Celestial coordinate calculation
- Refraction/weather/geoid handling
- Result sorting and display-count slicing
- UI and search criteria

## Verification

- TypeScript transpile diagnostics for the changed file: 0
- ZIP integrity test: passed
- Full `tsc -b` and Vite production build: not verified because required external packages remain unavailable in this environment
