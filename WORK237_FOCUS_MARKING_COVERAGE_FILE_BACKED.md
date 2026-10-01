# Work237 - Focus marking coverage file-backing and confidence allocation correction

Date: 2026-08-25
Baseline: Work236

## 1. Corrected Work235 confidence-memory claim
Work235 disabled writes into the retained confidence output when
`retainConfidence=false`, but source audit in Work237 found that the file-backed
builder still allocated `Float32List(pixels)` unconditionally.

Work237 fixes the allocation itself:
- retainConfidence=true -> full Float32 confidence plane, preserving diagnostic
  and test behavior;
- retainConfidence=false -> zero-length retained confidence plane.

At 6000x4000 this removes the actual 96,000,000-byte (~91.6 MiB) allocation
from the production focus-marking result path.

Confidence calculation itself is unchanged and is still performed for every
pixel before reliable-winner / reliable-overlap decisions.

## 2. File-backed non-reference coverage masks
Pre-composite focus marking previously retained one full-resolution Uint8
coverage plane per non-reference frame until final mask selection.

For 24 MP:
- each mask = 24,000,000 bytes;
- 10 total frames -> 9 non-reference masks = 216,000,000 bytes (~206 MiB).

Work237 now writes each non-reference coverage plane into the existing focus
score temporary directory, releases the frame-local coverage with the aligned
luminance object, and reads coverage back in the same bounded chunks used for
file-backed score selection.

Reference coverage remains `null`, meaning all-valid exactly as before.

The selection semantics remain:
`covered = mask == null || mask[pixel] != 0`.

## 3. Compatibility
`buildHighPrecisionFocusMarkingFromScoreFiles` keeps support for resident
`validMasks` for existing tests/diagnostic callers and adds mutually-exclusive
`validMaskFiles` for production.

## Verification
- Node: 644/644 PASS.
- Native Release CTest: 8/8 PASS.
- Native host ABI exports: 10/10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN here; Flutter/Dart SDK unavailable.
- Physical Pixel memory/process-death: NOT RUN.
- Adobe readback/A-B: NOT RUN.

## Quality contract
No confidence formula, focus threshold, overlap threshold, mask criterion,
feature matching, alignment, bicubic interpolation, focus score, winner logic,
regularization, blending, RAW/demosaic/color/DNG behavior, or
BaselineExposure=0 EV was changed.
