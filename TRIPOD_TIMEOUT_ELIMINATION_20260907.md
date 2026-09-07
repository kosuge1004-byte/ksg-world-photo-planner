# Tripod candidate timeout elimination — 2026-09-07

## Trigger
Real-device report: `TRIPOD_CANDIDATE_WATCHDOG_TIMEOUT` while the preview remained blank and the tripod candidate never finalized.

## Changes
- Added `water-only` OSM site-context purpose. It asks only for mapped water polygons; highway/access/park/building detail queries are excluded.
- River nearest-land search keeps the same 10 radii × 8 bearings (80 probe locations), but DEM sampling is batched and all water classification is sent as one `water-only` request instead of 10 sequential full-context requests.
- Initial water-surface classification now uses `AbortController` with a 5 s stage budget and aborts the actual fetch.
- River nearest-land water classification uses a 7 s stage budget and aborts the actual fetch.
- `water-only` bypasses shared in-flight request deduplication so abort reaches the underlying fetch; normal `full` and `height-only` behavior is unchanged.
- If water-only lookup cannot complete within its stage budget, tripod calculation continues with the existing terrain-derived fallback rather than blocking the whole search.
- The 90 s global watchdog remains only as a final safety net for unrelated unknown stalls; this change removes the identified serial OSM path that could consume it.

## Precision
The river search geometry is unchanged: the same radii `[3,6,10,15,25,40,60,90,140,220] m` and bearings `[0,45,90,135,180,225,270,315]°` are evaluated. The optimization changes I/O scheduling and query scope, not the candidate geometry.

## Validation
- TypeScript transpile syntax check: changed TS files PASS.
- `verify-water-surface-zero-20260903.mjs`: PASS.
- `verify-tripod-candidate-performance-resilience.mjs`: PASS.
- `verify-tripod-timeout-elimination-20260907.mjs`: PASS.
