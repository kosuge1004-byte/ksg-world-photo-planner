# Work160 Quality Batch — Stacking / Frame Quality / Registration Audit

Status: WIP. Flutter/Dart SDK tests, analyze, and APK build are still unavailable in this environment.

## Implemented in this batch

### Normal Milky Way stack
- Production/high-level path defaults to Gaussian PSF centroid refinement.
- Production/high-level path now defaults to comprehensive frame-quality weighting.
- The comprehensive weight combines:
  - registration RMS quality,
  - detected-star roundness,
  - detected-star count relative to the reference.
- DetectedStar metrics are preserved when preview coordinates are scaled back to source coordinates.
- Existing bicubic resampling and kappa-sigma combine remain unchanged.
- Low-level `registerAndCombineDecodedFrames` defaults remain backward-compatible; the high-level production path explicitly opts into the quality features.

### CFA Drizzle
- Production/high-level defaults are aligned to:
  - PSF refinement ON,
  - comprehensive frame-quality weighting ON,
  - robust rejection ON.
- Low-level `registerAndDrizzleCalibratedMosaics` defaults remain backward-compatible.
- Existing zero-MAD robust-rejection fix remains present:
  a majority-identical set with an isolated clear outlier rejects the outlier instead of retaining it.

## Audited but intentionally not forced
- Local residual registration: can improve lens/distortion residuals, but can over-fit when matches are sparse or geometry is weak. Kept optional.
- `useRealDemosaic` in CFA Drizzle export: only valid at outputScale == 1, while the quality drizzle path defaults to supersampled outputScale == 2. Not forced.
- 16-bit TIFF path: no extra 8-bit intermediate quantization was found in the audited path; no speculative change made.

## Executed validation
- Node reference/regression suite: 369/369 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Static high-level/low-level default contract checks: passed.
- Flutter/Dart tests/analyze/APK build: not run (SDK unavailable).
