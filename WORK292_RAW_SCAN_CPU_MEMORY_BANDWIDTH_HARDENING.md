# Work292 RAW scan CPU / memory-bandwidth hardening

Base: Work291.

## Verified issue in Work291
`NativeRawDecoder._validateFrame()` scanned the entire FP32 RAW plane to reject non-finite values. Immediately afterwards `_captureSaturationMask()` scanned the same full plane again through `RawSaturationMask.fromPredicate()`. For a normal orientation-1 frame this meant two complete Dart-side sensor-plane reads before calibration, and the second scan paid a per-pixel predicate callback cost.

## Change
- Added `RawSaturationMask.fromFiniteFloat32Threshold()`.
- Finiteness validation and the unchanged saturation test (`sample >= whiteLevel`) now happen in one direct loop.
- Removed the separate `frame.samples.any(...)` full-frame pass.
- `_captureSaturationMask()` maps the same non-finite condition back to the existing `RawDecodeFailure(corruptData)` contract.

## Quality
No image math, precision, threshold, CFA phase, calibration, demosaic, registration, stacking, or export behavior was intentionally changed. The saturation comparison remains exactly `sample >= whiteLevel`.

## Resource effect
This removes one complete FP32 RAW-plane read and removes a per-pixel Dart callback from the remaining pass. It primarily reduces CPU time and memory-bandwidth traffic; it does not claim to remove the LibRaw ushort + FP32 overlap during native decode.

## Validation limits
The current environment has no Flutter/Dart SDK, so Dart unit tests, `flutter analyze`, APK build and device profiling were not run. Static source checks were performed.
