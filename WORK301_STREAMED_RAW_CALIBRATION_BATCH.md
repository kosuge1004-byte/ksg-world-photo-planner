# Work301 — streamed RAW calibration batch

## Implemented in one batch

1. The Work300 native decode-to-file API is now routed into the standard background stack/star-trail path.
2. RAW calibration is fused into 64-row chunks and written directly to a second file-backed CFA store.
3. Preserved order: LinearizationTable -> BlackLevel(+DeltaH/V) -> Dark -> WhiteLevel normalization/clamp -> Camera WB -> Flat.
4. The source saturation/invalid mask is built as one packed bit per pixel while rows are processed.
5. File-backed master dark/flat are read row-wise; they are never materialized as full frame arrays.
6. Native production demosaic reads the calibrated store tile-by-tile directly; no post-calibration full-frame RAW Float32List is created.
7. Streamed path is conservative: only full ActiveArea + Orientation=1, file-backed masters, and no hot-pixel detection. Unsupported geometry falls back to the established in-memory path.
8. Existing foreground/session callers remain unchanged because the new executor flag defaults to false.

## Memory structure

The new standard-background path does not intentionally allocate a full-frame Dart/native FP32 sensor plane after native streamed decode. Its principal full-image RAM structure is the packed invalid mask (1 bit/pixel); sensor/calibration samples are row-chunked and demosaic input is tile-chunked. LibRaw's own unpacked raw buffer still exists during native decode and is a remaining peak.

## Quality invariants

The arithmetic/order mirrors the established in-memory pipeline. No resolution, precision, CFA, demosaic, registration, stacking, or export setting is reduced. Saturation is captured from the stored sensor sample against WhiteLevel before linearization, matching NativeRawDecoder's existing normalization path. Dark invalid sites are passed through and marked invalid. Flat invalid/<=0.05 sites are passed through and marked invalid.

## Validation limits

- Static wiring and delimiter checks performed.
- Native code was not changed from Work300/Work299.
- Flutter/Dart SDK is unavailable in this environment, so analyzer/Dart tests/APK/device RSS are not run.
- Runtime equivalence of the new fused Dart loop therefore remains UNVERIFIED until executed in a Dart/Flutter-capable environment.

## Added parity test source
`test/streamed_raw_calibration_parity_test.dart` constructs a deliberately non-byte-aligned 5x4 CFA frame, applies LinearizationTable, BlackLevelDeltaH/V, file-backed dark, WhiteLevel normalization, WB and file-backed flat through both the established in-memory sequence and the new streamed sequence, then requires exact Float32 sample ordering and per-pixel invalid-mask equality. The test source is present but cannot be executed here because Dart/Flutter is unavailable.

## Device evidence hook
The standard background worker now records one diagnostic entry per frame: `rawPath frame=<n> path=streamed-file-backed` when the new path is actually used, or a `memory-fallback:*` reason when it is not. This makes field logs sufficient to verify whether the optimization was active instead of inferring it from RSS alone.
