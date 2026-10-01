# Work264 Resource Lifecycle Final Batch Audit

## Scope
Work263 was re-audited specifically for failure-path ownership, multi-resource creation/commit/abort, partial export cleanup, and temporary file/store cleanup. No image-quality algorithm or rendering parameter was intentionally changed.

## Fixed findings

1. `tiled_cfa_drizzle.dart`
   - Previously, value/coverage/saturation output stores were created before the protected `try/finally`. If a later factory failed, an already-created earlier store could be stranded.
   - Abort cleanup was sequential, so one abort failure could prevent later stores from being aborted.
   - Creation now occurs inside the protected lifecycle and all created stores are attempted during abort cleanup.

2. `tiled_robust_combine_cfa_drizzle.dart`
   - Same partial-construction leak risk between value and coverage output stores.
   - Both stores are now created inside the protected lifecycle and both aborts are attempted.

3. `export_result.dart`
   - TIFF/BigTIFF partial-output deletion could be skipped if `RandomAccessFile.close()` itself failed.
   - Close and partial-file deletion are now nested so deletion is still attempted after a close failure.

4. `meteor_composite_result.dart`
   - Output-store cleanup failure could prevent background-store cleanup.
   - Background cleanup is now guaranteed to be attempted with nested `finally` handling.

5. Focus-stack cleanup paths
   - `focus_marking_analysis_pipeline.dart` and `focus_stack_pipeline.dart`: one RGB-store `dispose()` failure no longer prevents remaining stores from being disposed.
   - `focus_map_regularizer.dart`: all open handles, temporary files and owned directory are independently attempted; first cleanup error is preserved after all attempts.
   - `focus_measure.dart`: score/integral sidecar handles and files are all attempted even if an earlier close fails.
   - `high_precision_focus_marking.dart`: all reader/writer handles are attempted instead of stopping on the first close failure.

6. `file_backed_linear_raw_mosaic_store.dart`
   - The RAW mosaic has both main and saturation-sidecar resources. Previously, a failure closing/deleting the saturation side could prevent the main resource from being closed/deleted.
   - Cleanup now attempts both handles, both files and the owned directory, while preserving the first encountered cleanup error after all attempts.

## Quality invariants intentionally unchanged
- RAW decoding and camera compatibility
- calibration and saturation semantics
- demosaic
- PSF centroiding
- global similarity registration
- local residual correction
- bicubic resampling
- frame weighting
- robust small-stack seed and kappa-sigma rejection
- CFA Drizzle numerical accumulation/rejection
- Linear DNG sample values/metadata/headroom
- JPEG/TIFF tone mapping and export quality settings

## Verification status
Static source checks only. Dart/Flutter SDK is not installed in this environment, so `dart analyze`, `flutter analyze`, `flutter test`, Android release build, and real Sony ILCE-7M3 ARW validation were not run.
