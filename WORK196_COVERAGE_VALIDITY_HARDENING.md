# Work196 - Coverage validity hardening

## Goal
Highest-quality CFA Drizzle output must never treat a completely unsupported sample (coverage=0) or non-finite/negative coverage as valid source data.

## Changes
1. `minimumCoverage` is now required to be finite and strictly positive in:
   - `lib/core/drizzle/drizzle_gap_fill.dart`
   - `lib/core/drizzle/tiled_drizzle_gap_fill.dart`
   - `lib/core/export/cfa_drizzle_dng_validity.dart`
   - matching Node reference implementations.

   Rationale: when `minimumCoverage == 0`, an actual hole with coverage 0 satisfies `coverage >= minimumCoverage`, so it can bypass gap filling and can be classified as source-supported in a DNG mask. A coverage threshold used to distinguish source-supported data from holes must therefore be > 0.

2. Native-CFA demosaic DNG-validity path now explicitly rejects non-finite or negative native-channel coverage before threshold comparison. This prevents NaN from bypassing `coverage < minimumCoverage` and becoming implicitly valid.

3. Node reference implementation and regression tests were synchronized with the production contract.

## Quality impact
- Prevents true drizzle holes from being mislabeled as measured pixels if a caller supplies a zero threshold.
- Prevents invalid coverage values from propagating into Linear DNG validity decisions.
- Does not modify RAW decoding, calibration, registration, CFA splatting, robust value combine, demosaic kernels, color transforms, or Linear DNG writer math.

## Verification in this environment
- All Node test files under `tool/**`: 510/510 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI export check: 10 exports PASS.
- Native ASan/UBSan CTest: 8/8 PASS.
- Flutter/Dart analyze/test/APK and Pixel real-device testing remain NOT RUN because this runtime has no Flutter/Dart/adb.
