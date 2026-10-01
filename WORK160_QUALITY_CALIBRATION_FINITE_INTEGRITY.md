# Work160 — Quality-first calibration finite-value integrity

Status: WIP.

## Implemented
- `computeMasterDark` now rejects any NaN/Inf input before per-pixel median
  combination.
- `computeMasterFlat` now rejects any NaN/Inf input before per-pixel median and
  CFA-color normalization.
- `applyFlatFieldCorrection` now rejects:
  - non-finite light/master-flat samples,
  - non-finite or negative `minimumFlatValue`,
  - any non-finite correction result.
- `detectHotPixelsFromMasterDark` now rejects:
  - non-finite master-dark samples,
  - non-finite ratio/absolute thresholds.

## Why this is a strong-evidence change
Median sorting is not a validity filter. A NaN/Inf can be missed or contaminate
calibration depending on ordering and frame count. Calibration data is reused
across every light frame, so silently accepting a non-finite master value can
propagate corruption through dark subtraction, flat division, defect detection,
demosaic, registration, and stacking. The correct safe behavior is explicit
rejection before calibration statistics are computed.

No kappa, noise-reduction strength, hot-pixel threshold, or image-look parameter
was changed.

## Audit result
The normal weighted kappa-sigma implementation was reviewed in this batch. No
clear numerical/specification bug was established, so its kappa/default
thresholds were deliberately left unchanged.

## Executed validation
- Node/reference suite: 389/389 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Dedicated NaN/Inf dark, flat, flat-apply, and hot-pixel tests: passed.
- Static Dart contract checks: passed.
- Flutter/Dart SDK unavailable: Dart tests/analyze/APK not executed.
