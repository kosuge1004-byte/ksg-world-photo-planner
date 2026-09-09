# HTTP wave reduction — 2026-09-09

## Change
The GSI elevation client now chooses its initial chunk size from the number of workers that one call can actually run concurrently.

Previous behavior:
- global max requests: 6
- per-call reserve: 2
- real per-call workers: 4
- 640 points were still split as if 6 workers were available, creating about 6 batches and forcing a second wave.

New behavior:
- effective per-call workers: 4
- 640 points are split to about 160 points x 4 batches
- all four batches can run in the first wave

This reduces HTTP round trips without changing points, source priority, interpolation, or stored elevation values.

## Verification
- HTTP wave reduction: 6/6 PASS
- Direct download regression: 13/13 PASS
- R2 safety: 11/11 PASS
- DEM5A gating: 6/6 PASS
