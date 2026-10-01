# Work231 — Focus-map regularization file-backed working pair

## Purpose
Reduce full-resolution resident memory during production focus-map regularization without changing the two-pass regularization semantics or image-quality decisions.

## Previous production behavior
The production path called `regularizeFocusWinnerMap(... reuseInputBuffers: true)`.
For a 6000x4000 image the selected winner map contains:
- Int32 winner indices: 24,000,000 * 4 = 96,000,000 bytes
- Float32 confidence: 24,000,000 * 4 = 96,000,000 bytes

The two-pass regularizer also allocated one alternate full-resolution pair of the same size. Therefore the winner-map regularization stage could keep about 384,000,000 bytes resident across the input and alternate pairs alone.

## Work231 change
Production now calls `regularizeFocusWinnerMapFileBackedTwoPass`.

Pass 1 reads the original in-memory winner/confidence pair and writes the alternate Int32/Float32 pair to temporary files. Pass 2 reads those files through a rolling row-neighborhood cache and writes the final result back into the caller-owned original buffers.

The standard radius=2 path retains only the required five input rows plus one output row and small neighbor scratch buffers, instead of a second full-resolution resident pair.

For 6000x4000 this removes approximately 192,000,000 bytes of additional resident typed-array allocation from the regularization stage. Temporary storage increases by approximately the same 192,000,000 bytes while the two-pass regularization is active.

## Quality invariants
No focus score, winner rule, confidence formula, anchor threshold, weighted ordinal median, candidate majority rule, iteration count, RGB blend, registration, demosaic, color transform, DNG normalization, or BaselineExposure behavior was intentionally changed.

A Flutter unit test compares the file-backed two-pass result against the existing in-memory two-pass implementation for exact winner-index and Float32-confidence equality. It is committed but could not be executed locally because Flutter/Dart SDK is unavailable in this environment.

## Validation completed here
- Node: 627/627 PASS across 117 files
- Native Release CTest: 8/8 PASS
- Native ABI exports: 10/10 PASS
- ASan/UBSan: 8/8 PASS
- Flutter/Dart: NOT RUN (SDK unavailable)
- Pixel real-device: NOT RUN (device unavailable)
- Adobe readback: NOT RUN (Adobe unavailable)
