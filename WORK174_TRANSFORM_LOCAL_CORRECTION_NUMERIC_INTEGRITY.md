# Work174 — Star transform / local correction numeric integrity

Status: WIP.

## Implemented

### Global star transform estimation
- All runtime quality parameters are validated in release code.
- Matching tolerances must be finite and positive.
- hypothesis/refinement limits must be positive integers.
- minimum inliers must be >= 2.
- pair-distance and RMS acceptance thresholds must be finite and valid.
- the final rotation, offsets, center and RMS residual must all be finite
  before a transform estimate is returned.

### Shared similarity-transform math
- Transform parameters must be finite.
- Forward/inverse point coordinates must be finite.
- Invalid transforms can no longer silently enter trigonometric mapping.

### Local residual correction
- Every match reference coordinate and residual must be finite.
- Fitted polynomial coefficients must remain finite; otherwise the existing
  safe zero-field fallback is used.
- evaluation coordinates must be finite.
- evaluated dx/dy and correction magnitude must remain finite.

### Iterative inverse with local correction
- source coordinates must be finite.
- initial inverse guess must be finite.
- global prediction and local correction must stay finite at every iteration.
- divergence to a non-finite point is rejected immediately.

## Why this is quality-first
Star matching and local residual correction define the geometric mapping used
to align frames. A single NaN/Inf transform parameter can shift or smear every
star in the output. These changes reject invalid numerical state without
retuning any alignment threshold or changing the geometric model.

## Intentionally unchanged
- RANSAC/matching strategy.
- tolerance defaults.
- RMS acceptance default.
- local polynomial degree.
- maximum local correction default.
- fixed-point iteration count.
- star-selection thresholds.

Those need image-level evidence before tuning.

## Regression preparation for later Codex/Flutter
Dart regressions added for:
- invalid star-transform parameters;
- non-finite local residual matches/evaluation;
- non-finite local-correction inverse input.

## Executed validation
- Node/reference/source-contract suite: 459/459 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here: Dart tests/analyze/APK not executed.
