# Work177 — CFA Drizzle / gap integrity

Status: WIP.

## Drizzle audit
The current CFA drizzle maps square input drops through the frame transform and
accumulates values using geometric overlap area times frame weight. This matches
the core Variable-Pixel Linear Reconstruction / Drizzle model.

The default pixfrac remains 0.7. It was not retuned: authoritative DrizzlePac
guidance states that no single pixfrac is optimal for every dataset; sharpness
versus coverage depends on frame count, output scale and sub-pixel dithering.

## Confirmed integrity issue fixed
Gap filling could accept non-finite sample/coverage state and NaN
minimumCoverage, allowing comparison logic to fail silently and NaN to
propagate.

Implemented:
- positive dimensions;
- finite channel values;
- finite non-negative coverage;
- finite non-negative minimumCoverage;
- tiled gap-fill enforces the same minimumCoverage contract;
- Node reference mirrors production behavior.

## Intentionally unchanged
- pixfrac default 0.7;
- outputScale default 2;
- overlap-area accumulation;
- per-frame weighting;
- same-CFA-channel gap filling;
- gap-fill radius/default threshold.

## Executed validation
- Node/reference/source-contract suite: 70/70 passed.
- Native clean CMake configure/build passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here: Dart tests/analyze/APK not executed.
