# Work297 — File-backed calibrated light RAW during demosaic

## Scope
Work296 still retained one full calibrated light-frame FP32 CFA plane throughout the tile-by-tile demosaic stage. Work297 changes only the Android/headless standard-stack worker opt-in path; existing callers keep the in-memory path by default.

## Code changes
- `runPhase2ValidatedJob` gained `fileBackRawBeforeDemosaic` (default `false`).
- `standard_stack_background_worker.dart` opts in with `true`.
- The production native demosaic path spills the already-calibrated light CFA plane to `FileBackedLinearRawMosaicStore` in 64-row full-width views, commits it, removes `PipelineContext.rawMosaic`, and demosaics by reading only each planned input rectangle.
- `NativeMobileStackDemosaicEngine.processFileBackedTile` sends the same global image width/height, CFA pattern, absolute input/output coordinates, and local CFA buffer origin/dimensions required by native ABI v3.
- The full saturation mask remains only in packed 1-bit-per-pixel form and is reused across tiles; it is not duplicated into the short-lived light RAW store.
- `runPhase2ValidatedJob` no longer retains the `RawDecodeResult` as a second Dart reference to the same full-frame mosaic after metadata has been extracted.

## Quality invariants
No calibration arithmetic, demosaic kernel, CFA phase, overlap, input radius, output precision, registration, stacking or export formula was changed. Native test `test_nonzero_origin_local_cfa_buffer` already proves that compact local CFA buffers with non-zero global origin produce bit-identical RGB to the full-image-buffer request; that test remains in `mobile_stack_demosaic_cache_test` and passes in the Work297 native build.

## Memory effect
During the long demosaic phase the production background standard-stack path no longer needs to intentionally retain the full calibrated light CFA plane in `PipelineContext`. The file-backed source materializes only the current input rectangle. A full FP32 CFA plane is 4 bytes/pixel: about 132 MB at 33 MP and 240 MB at 60 MP. These are allocation-size reductions, not measured RSS reductions. Work291 native external memory is finalizer-managed, so actual release timing remains subject to Dart GC and must be verified on device.

## Trade-off
This adds one sequential write of the calibrated light RAW plane plus per-tile reads. It deliberately trades storage I/O for lower resident memory during demosaic. The opt-in is limited to the long-running background standard-stack/star-trail worker; all other callers keep the previous path.

## Validation performed here
- Native Release configure/build: PASS.
- CTest: 7/8 PASS. `mobile_stack_arw_lossless` fails at the same pre-existing pixel-limit assertions (lines 367/457) seen in Work288–Work296.
- `mobile_stack_demosaic_cache`: PASS, including `test_nonzero_origin_local_cfa_buffer`.
- Dart/Flutter analyze/tests/APK/device RSS: NOT RUN because Dart/Flutter SDK is unavailable in this environment.
