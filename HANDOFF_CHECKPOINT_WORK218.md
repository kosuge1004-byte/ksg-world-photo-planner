# Work218 checkpoint
Baseline: Work217.

Implemented:
- Added an end-to-end focus-stack image pipeline from accepted RAW probes through production RAW decode and production demosaic.
- The first user-ordered RAW is the geometric reference.
- Remaining frames run through feature correspondence, scaled-similarity focus-breathing alignment, one-pass bicubic resampling, coverage-aware focus measure, winner selection, adjacent focus-order refinement, confidence-aware regularization and halo-aware blend.
- Temporary demosaic stores are disposed in a finally block.
- Output is explicitly linear camera RGB + coverage + winner map + reference RAW metadata.
- Final camera->output color transform and Linear DNG packaging are intentionally deferred to the next work.
- Progress reporting is monotonic: demosaic occupies 0..45%, alignment/focus 45..80%, regularization 88%, completion 100%.

Verification:
- Node after final progress fix: 563/563 PASS.
- Native Release CTest before progress-only fix: 8/8 PASS.
- Native ABI exports before progress-only fix: 10 PASS.
- ASan/UBSan before progress-only fix: 8/8 PASS.
- The final change after native checks modified only Dart progress arithmetic and a Node source-contract test; native code was not changed.
- Flutter analyze/test/APK: NOT RUN here.
