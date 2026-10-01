# Work300 — Dart bridge for Native streamed RAW decode

## Scope
Work299 added `mobile_stack_raw_decode_to_file()` on the native side but did not connect it to Dart.
Work300 adds the Dart FFI binding and a typed file-backed decode contract.

## Changes
- `FfiRawNativeBridge.decodeToFile()` binds `mobile_stack_raw_decode_to_file`.
- Validates ABI/status/dimensions and requires `result.samples == nullptr`.
- `FfiRawDecodeCurrentIsolateBackend` implements `RawNativeFileDecodeBackend`.
- `NativeRawDecoder` implements `RawFileBackedDecoder`.
- Added `FileBackedRawDecode` helper which owns the temporary directory and opens the
  native FP32 file as `FileBackedLinearRawMosaicStore`.
- Stream path is deliberately restricted to already-normalized geometry:
  full ActiveArea and Orientation=1. Other RAWs must fall back to the established
  in-memory normalization path until a file-backed crop/orientation transformer is added.

## Memory consequence
On the new API, Dart receives metadata + a file path, not a full-frame `Float32List`.
Therefore the Work299 native streamed decode can now be called from Dart without
re-materializing the sensor plane.

## Not yet changed
This Work does NOT yet route `runPhase2ValidatedJob` through the streamed API and
does NOT yet perform black/white/WB/dark/flat calibration directly on the file-backed
sensor plane. That is the next step.

## Validation
- Native source is unchanged from Work299.
- Static source checks performed.
- ZIP CRC test performed.
- Flutter/Dart SDK unavailable in this environment, so analyzer/tests/APK build not run.
