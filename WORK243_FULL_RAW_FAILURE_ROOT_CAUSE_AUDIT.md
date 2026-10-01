# Work243 - Full RAW failure root-cause audit

Date: 2026-08-26
Baseline: Work242 (Work241 HTML preview remains discarded)

## Scope
Audited the shared normal RAW path used before Milky Way and Star Trails split:
file_picker -> local path -> RawFileProbe -> metadata probe -> native ARW decoder -> Dart FFI ownership -> calibration -> native demosaic -> JobScheduler -> mode-specific combine/export.
Also inspected the originally supplied app-release.apk native payload.

## Definite defect fixed: native RAW sample use-after-free
`FfiRawNativeBridge._copyResult()` created a Dart `Float32List` view directly over `result.samples` with `asTypedList()`.
`FfiRawNativeBridge.decode()` then always called `mobile_stack_raw_decode_result_release()` in `finally`.
The native release function calls `free(result->samples)`.
Therefore the returned RawNativeDecodedFrame could reference freed native memory before validation, normalization or pipeline processing.

Work243 copies the full sample plane with `Float32List.fromList(...)` before native release.
A Node source contract now pins both sides of the ownership rule.

## Historical 49/49 failure narrowed from code
The old Work238 APK used the DNG-only feature-flagged metadata probe for normal ARW selection and processing, so ARW files were accepted by generic TIFF-header probing and then reached the native decoder without production ARW metadata preflight.
All jobs showing zero aggregate progress means the common failure was before the first ProcessingPipeline stage reported progress.
Given that the same files had already passed selection RawFileProbe, the remaining common pre-stage paths are native library open/ABI, native ARW decode, or immediate decoded-frame validation/normalization.

The supplied app-release.apk contains `lib/arm64-v8a/libmobile_stack_raw.so`, the RAW ABI symbols, and Sony ARW decoder error strings, so a completely missing native library is not supported by the APK evidence.

## Confirmed ARW format limitation
The bundled native Sony decoder accepts only:
- TIFF Compression 7 JPEG Lossless / SOF3 under its bounded tile contract;
- Sony ARW2 Compression 32767 under its bounded strip contract.

It rejects other Sony sensor layouts, including uncompressed Compression 1 and newer unsupported compression layouts. The repository's native README states the same limitation.
This can cause every selected frame from one camera/RAW setting to fail identically.

No unsupported layout decoder was added without a representative real RAW corpus because doing so without exact byte-layout evidence risks silent pixel corruption.

## Other candidates audited
- Android APK packaging: arm64 RAW library present; not excluded by source assumptions.
- RAW maximum pixel count: 64,000,000 pixels; not a problem for 24 MP or 33 MP full-resolution files.
- Job concurrency: normal full-frame RAW path is currently forced to 1 worker via `fullFrameRawConcurrencyPolicy`; settings UI text saying max 12 is misleading but not the current common RAW failure cause.
- Camera WB absence: pipeline explicitly skips WB when unavailable; not an all-frame fatal condition.
- Missing D65 matrix: render profile can remain without a linear color transform; this is not the zero-progress all-job failure path.
- file_picker path: files that reach the processing screen already passed file existence/header checks during selection; path invalidation remains possible but is not proven from the old screenshot.
- Mode-specific Milky Way/Star Trails combine logic runs after per-frame jobs; it cannot explain 49 individual jobs failing at zero progress.

## Work240/242 diagnostics retained
Production native ARW metadata preflight and per-file exact failure messages remain enabled. A current APK rerun will distinguish unsupported ARW layout, native file I/O, resource limit, native OOM, decode failure, and later-stage errors.

## Verification boundary
Node and native host suites are executed here. Flutter analyze/test/APK and physical-device RAW rerun require the external Flutter/Android environment.

## Verification results
- Node: 663/663 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10/10 PASS.
- ASan/UBSan: 8/8 PASS.
- Supplied old APK arm64 `libmobile_stack_raw.so`: 10/10 required exports present.
- Flutter analyze/test/APK build: NOT RUN here; Flutter/Dart SDK unavailable.
- Physical-device rerun of the failing 49 files: NOT RUN.
