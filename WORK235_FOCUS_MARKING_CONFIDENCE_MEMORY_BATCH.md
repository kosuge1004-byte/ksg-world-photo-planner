# Work235 - Focus marking retained-confidence memory batch

Date: 2026-08-25
Baseline: Work234

## Change
The file-backed high-precision marking builder previously always retained one
full-resolution Float32 confidence plane in the returned
`HighPrecisionFocusMarking`.

Production review/omission/auto-exclusion code does not consume that plane.
Confidence is still computed per pixel and is still used unchanged for:
- reliable winner marking,
- acceptable-overlap marking,
- minimum confidence threshold,
- exact frame mask construction.

The file-backed builder now has `retainConfidence` with default `true`, preserving
existing tests/diagnostic callers. The production focus-marking pipeline passes
`retainConfidence: false`, so it returns an empty diagnostic confidence payload
while preserving the exact frame masks and coverage fractions.

6000x4000 retained-memory saving after analysis:
24,000,000 pixels * 4 bytes = 96,000,000 bytes (~91.6 MiB).

## Verification
- Node: 637/637 PASS.
- Native Release CTest: 8/8 PASS.
- Native host ABI exports: 10/10 PASS.
- ASan/UBSan: 8/8 PASS with libasan preload.
- Flutter analyze/test/APK: NOT RUN; Flutter/Dart SDK unavailable.
- Physical Pixel RSS/process-death: NOT RUN.
- Adobe readback/A-B: NOT RUN.

## Quality contract
No focus confidence formula, threshold, winner logic, overlap logic, mask pixel,
RAW decode, demosaic, registration, bicubic interpolation, blending, color/DNG
processing, or BaselineExposure was changed.
