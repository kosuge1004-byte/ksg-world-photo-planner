# Work233 - Focus memory lifetime and cleanup batch

Date: 2026-08-25
Baseline: Work232

## Changes

### 1. Release source luminance before aligned luminance allocation
For each non-reference frame, correspondence estimation still uses the exact
existing full-resolution reference/source green planes and the same feature
detector, matcher and robust scaled-similarity fit.

After correspondence is fixed, the source luminance local is explicitly cleared
before the aligned green plane is allocated. The resampling stage is split into
`resampleFocusLuminanceForMarking`, which keeps:
- the same `TiledAffineRgbResampler`,
- `ResamplingInterpolation.bicubic`,
- the same combined alignment transform,
- the same green-channel extraction,
- the same coverage propagation.

At 6000x4000, one Float32 luminance plane is 96,000,000 bytes (~91.6 MiB).
The change removes that plane from the live object graph before the equally
large aligned plane is allocated. Actual physical RSS reduction remains a
runtime/GC property and must be measured on Pixel hardware.

### 2. Prevent file-backed final-result temp leak on repeated analysis
Work230+ stores the final RGB result in a temporary file-backed store. Starting
a new focus analysis previously cleared `_lastResult` without disposing the old
store. Repeated analyze cycles could therefore orphan a roughly 288,000,000-byte
6000x4000 RGB store.

The previous result is now disposed before `_lastResult` is cleared. Analysis
also defensively refuses entry while DNG saving is active, and stale saved-path
UI state is cleared when a fresh analysis begins.

### 3. Regression contracts
Added Node source contracts for:
- source-luminance release ordering,
- split marking resampler bicubic/transform/green/coverage invariants,
- previous result disposal before UI reference clearing.

Updated two older source contracts whose exact call-count/API assumptions were
made obsolete by the split path. No numerical expectation was weakened.

## Quality contract
No RAW decode, calibration, demosaic, feature detection/matching, robust
alignment fit, bicubic interpolation, focus-measure formula, winner selection,
regularization, halo-aware blending, color transform, DNG normalization or
BaselineExposure value was changed.

## Verification
- Node: 631/631 PASS.
- Native Release CTest: 8/8 PASS.
- Native host ABI exports: 10/10 PASS.
- ASan/UBSan: 8/8 PASS with libasan preload.
- Flutter analyze/test/APK: NOT RUN here; Flutter/Dart SDK unavailable.
- Physical Pixel memory/process-death: NOT RUN.
- Adobe Lightroom/Camera Raw/Photoshop readback/A-B: NOT RUN.
