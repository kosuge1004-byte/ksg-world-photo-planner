# Work160 — DNG metadata/compression audit

Status: WIP.

## Evidence-led decisions
- Re-audited `RawFrameMetadata` and the native metadata ABI before adding EXIF.
- They currently do not expose ISO, ExposureTime, FNumber, FocalLength,
  DateTimeOriginal, or LensModel.
- Therefore no capture EXIF values were guessed or synthesized.
- Added `LinearDngProvenance` as a safe future contract for common camera/lens
  identity and source-frame count. Per-frame exposure metadata must be added to
  the decoder/probe layer before it can be propagated correctly.

## Compression
- Lossless compression remains a target, but was not enabled speculatively in
  this batch. The current writer stores IEEE Float32 LinearRaw uncompressed.
- Before enabling compressed Float32 DNG, the exact DNG floating-point
  compression/predictor byte stream must be implemented and independently
  decoded byte-for-byte. File size optimization must not risk image fidelity.

## Validation
- Node/reference suite: 376/376 passed.
- Native CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable in this environment: not executed.
- APK not built.
- Real Lightroom/Camera Raw interoperability remains unverified.
