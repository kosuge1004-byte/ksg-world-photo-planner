# Work170 — Registration numeric integrity

Status: WIP.

## Implemented

### Adaptive dual alignment
- Runtime validation now exists in release builds; quality-critical thresholds
  are no longer protected only by Dart `assert`.
- `identityAdvantageRatio` must be finite and strictly between 0 and 1.
- absolute/relative difference floors must be finite and non-negative.
- reference/source/output dimensions must agree exactly.
- reference/source invalid masks must match image dimensions.
- non-finite reference or identity RGB samples fail immediately.

### Affine RGB resampling
- Interpolated RGB is checked before coverage is set.
- A non-finite bilinear/bicubic result can no longer be tagged as a valid
  covered observation and propagated into stacking.

## Audited but intentionally unchanged
- Bicubic edge replication/clamping remains unchanged. It is a deliberate
  boundary condition and there is not enough evidence to claim that discarding
  the border footprint would improve image quality.
- Bicubic kernel, Catmull-Rom coefficients, registration thresholds and local
  correction parameters were not retuned.
- No crop of edge pixels was introduced.

## Regression preparation
A Dart regression was added for release-mode dual-alignment threshold
validation. Source-contract tests cover dimension/mask validation, finite input
checks and the resampler coverage ordering.

## Executed validation
- Node/reference/source-contract suite: 436/436 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable: Dart tests/analyze/APK not executed.
