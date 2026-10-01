# Work291 RAW decode zero-copy hardening for background workers

## Scope
This work targets the remaining full-resolution Native -> Dart FP32 copy on the Android/iOS RAW decode path used by headless background workers. Image-processing math, RAW values, CFA layout, calibration, demosaic, registration, stacking, and export precision are unchanged.

## Changes
1. Added `mobile_stack_raw_decode_result_take_samples()` to detach the decoded FP32 sensor allocation from `MobileStackRawDecodeResult` without copying it.
2. Added `mobile_stack_raw_samples_release()` as the native finalizer target for detached sample memory.
3. Added `FfiRawDecodeCurrentIsolateBackend` for callers that are already running in a dedicated background/headless isolate.
4. The background backend calls FFI directly and exposes the detached native allocation as an external `Float32List` with a native finalizer. It therefore does not allocate a second full-resolution Dart FP32 plane.
5. The generic/UI-capable `FfiRawDecodeWorker` retains the previous `Isolate.run()` + Dart-owned copy path. This avoids changing UI-isolate responsiveness and avoids carrying native lifetime across the `Isolate.run()` result boundary.
6. All long-running background RAW workers now use `createProductionBackgroundNativeRawDecoderRegistry()`:
   - standard stack / star trail
   - CFA drizzle
   - focus stack
   - focus marking
   - meteor
7. Native C contract test now verifies sample ownership can be detached, the result no longer owns the pointer, result release does not free it, and the detached sample memory is released separately.

## Memory effect
The background decode path no longer creates a second full-frame FP32 allocation solely to copy native samples into Dart. The eliminated allocation size is `width * height * 4` bytes (about 132 MB at 33 MP; about 240 MB at 60 MP). Actual process RSS peak reduction is device/decoder dependent because LibRaw's internal sensor buffer overlaps part of the decode lifetime.

## CPU effect
The O(pixel_count) Native -> Dart FP32 memory copy is removed from the background decode path. This reduces memory-bandwidth traffic and CPU work without altering pixel values.

## Validation performed
- Native Release configure/build: succeeded.
- CTest: 7/8 passed.
- `mobile_stack_raw_c_contract`: PASS, including the new detached-sample ownership test.
- DNG, demosaic, cache, ABI tests: PASS.
- `mobile_stack_arw_lossless`: same pre-existing pixel-limit failure as unmodified Work290 (`line 367`, `line 457`). Work290 was rebuilt in the same environment and reproduced the identical failure.

## Validation not performed
Flutter/Dart SDK is not installed in this execution environment, so `dart analyze`, `flutter analyze`, APK build, and Android device RSS profiling were not run here. Runtime RSS improvement must be confirmed on-device with the existing diagnostic memory logging.
