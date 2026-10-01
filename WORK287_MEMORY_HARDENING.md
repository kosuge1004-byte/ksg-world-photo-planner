# Work287 — RAW peak-memory hardening

Basis: Work286.

## Change
- Removed one redundant full-frame Dart Float32 copy in the native RAW decode handoff.
- The FFI bridge already copies `result.samples` while native ownership is valid. Work286 then copied that private Dart buffer a second time in `RawNativeDecodedFrame`.
- Added `RawNativeDecodedFrame.takeOwnedSamples` for the FFI-only ownership-transfer path; the normal public constructor keeps defensive-copy semantics.

## Expected effect
For an N-pixel RAW frame, the removed transient allocation is `N * 4` bytes. Examples: 33 MP ≈ 132 MB decimal; 60 MP ≈ 240 MB decimal. This reduces peak RAM and the CPU/memory-bandwidth cost of one complete sensor-plane copy.

## Quality contract
No sample values, precision, demosaic algorithm, calibration algorithm, stack algorithm, output resolution, or output encoding were changed. The same Float32 sensor samples are handed to the pipeline.

## Remaining memory work
The native LibRaw Float32 output still overlaps with the first Dart-owned Float32 copy during FFI transfer, and the native demosaic engine retains its own native full-frame CFA copy while processing a mosaic. Those require a larger ownership/tiling ABI redesign and were deliberately not changed in this low-risk step.

## Validation in this environment
Flutter/Dart SDK is unavailable, so `flutter analyze` and Dart tests cannot be executed here. Source-level checks and native build checks are performed separately.
