# Work234 - Focus marking memory and temp cleanup batch

Date: 2026-08-25
Baseline: Work233

## Changes

### 1. Removed redundant reference coverage in pre-composite focus marking
The reference frame is not resampled, therefore every reference pixel is valid.
The high-precision score and winner APIs already define `null` as all-valid.
The explicit all-ones full-resolution `Uint8List` was removed.

6000x4000 saving: 24,000,000 bytes (~22.9 MiB) resident allocation.

### 2. Split non-reference marking alignment lifetime
Pre-composite focus marking now follows the same Work233 lifetime discipline as
the final focus-stack pipeline:
- build the same full-resolution source green plane,
- estimate correspondence with the same feature detector/matcher and robust
  scaled-similarity fit,
- release the source green local,
- resample aligned green with the existing bicubic tiled resampler and the same
  combined transform,
- preserve the same per-pixel coverage,
- feed the aligned green plane to the unchanged high-precision score writer.

One 6000x4000 Float32 luminance plane is 96,000,000 bytes (~91.6 MiB). The
source plane no longer remains live by local reference while the aligned plane
is allocated. Actual RSS reclamation is runtime/GC dependent and remains a
physical-device measurement item.

### 3. Hardened temporary-resource cleanup ordering
Both the pre-composite marking pipeline and final focus-stack pipeline now nest
cleanup with `try/finally` so failure to delete a score/measure temporary
directory cannot skip disposal of the much larger file-backed RGB stores.

This changes cleanup reliability only; image data and numerical processing are
unchanged.

## Regression protection
Added contracts covering:
- null reference mask,
- source-luminance release ordering,
- guaranteed store disposal after score cleanup,
- guaranteed decoded-store disposal after final/measure cleanup.

One older marking connection contract was updated from the old combined helper
name to the current explicit correspondence + resample path. Numerical quality
expectations were not weakened.

## Verification
- Node: 635/635 PASS.
- Native Release CTest: 8/8 PASS.
- Native host ABI exports: 10/10 PASS.
- ASan/UBSan: 8/8 PASS with libasan preload.
- Flutter analyze/test/APK: NOT RUN; Flutter/Dart SDK unavailable here.
- Physical Pixel tests: NOT RUN.
- Adobe readback/A-B: NOT RUN.

## Quality contract
No RAW decode, calibration, demosaic, feature detection/matching, alignment
model, bicubic interpolation, focus score, winner logic, regularization,
blending, color transform, DNG normalization, or BaselineExposure was changed.
