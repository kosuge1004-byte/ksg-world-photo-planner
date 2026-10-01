# Work238 - Release static audit and Work237 null-safety correction

Date: 2026-08-25
Baseline: Work237

## Defect found
The Work237 file-backed coverage change made `validMasks` nullable in
`buildHighPrecisionFocusMarkingFromScoreFiles`, but the validation block still
contained:

`for (final Uint8List? mask in validMasks)`

without a null guard.

That is incompatible with Dart null-safety when the production
`validMaskFiles` path passes `validMasks == null`, and could prevent Flutter
analysis/build on the Work237 baseline.

## Fix
- Resident `validMasks` are validated only inside `if (validMasks != null)`.
- Otherwise `validMaskFiles!` are validated.
- Every non-null mask file must have exactly `width * height` bytes.
- Added Node contracts that pin the null guard and exact file length validation.

## Flutter equivalence regression added
Added a Dart/Flutter test that builds identical marking results using:
1. resident coverage masks;
2. file-backed coverage masks.

It compares:
- retained confidence,
- every frame mask,
- coverage fractions.

This test is not executed in this environment because Flutter/Dart SDK is not
installed here. Work236 CI already makes `flutter test` mandatory, so it will be
executed by the repository CI.

## Full release static audit result
Production source was scanned for unfinished implementation markers and release
stubs. No `FIXME`, `HACK`, `XXX`, `UnimplementedError`, or production
"not implemented" marker was found in `lib/`.

Remaining large memory objects are primarily:
- final high-precision frame masks (~24 MB per frame at 24 MP);
- temporary scene-noise-floor selection (~96 MB at 24 MP).

They are precision-critical. No approximation, downsampling, threshold change,
or lower-resolution replacement was applied in Work238.

## Verification performed here
- Node: 648/648 PASS.
- Native Release CTest: 8/8 PASS.
- Native host ABI exports: 10/10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN; Flutter/Dart SDK unavailable.
- Physical Pixel: NOT RUN.
- Adobe readback/A-B: NOT RUN.

## Quality contract
No RAW decode, calibration, demosaic, feature matching, alignment model,
bicubic interpolation, focus score, confidence formula, marking threshold,
winner/overlap criterion, regularization, blending, color transform, DNG
normalization, or BaselineExposure=0 EV was changed.
