# Stage 5F — Direction-crossing result-order audit

## Finding

The direction-crossing search applied `displayCount` inside the per-body loop. If multiple visible bodies crossed the target bearing within the same coarse sample interval, processing stopped as soon as the limit was reached. A body later in `BODY_ORDER` could refine to a slightly earlier crossing within that same interval and be omitted.

## Change

The early-exit check now runs only after all selected bodies for the current time step have been processed. Results are then sorted chronologically and sliced to `displayCount`.

## Scope

Only `src/search/celestialTransitSearch.ts` changed. Frame-search interval logic, weather/refraction, ECEF geometry, progress reporting, UI, and cancellation behavior were not modified.
