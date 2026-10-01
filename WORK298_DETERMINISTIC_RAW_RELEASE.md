# Work298 — deterministic native RAW sample release

## Verified source condition in Work297
Work291's background/headless RAW backend adopts the native FP32 allocation as an external `Float32List`. Work297 spills the calibrated full-frame CFA plane into `FileBackedLinearRawMosaicStore` before the long tiled native demosaic loop. However, the adopted native allocation was released only by `Pointer.asTypedList(... finalizer: ...)`, so actual release timing remained GC-dependent after the spill.

## Work298 change
- Added a neutral `RawSampleLease` ownership contract to `RawDecodeResult`; `RawNativeDecodedFrame.takeOwnedSamples` can carry it.
- The ordinary copying `RawNativeDecodedFrame` constructor never carries a lease because it creates an independent Dart copy.
- The FFI current-isolate zero-copy path now creates an explicit `_FfiRawSampleLease`. A `NativeFinalizer` remains attached to the external list as the safety net, while `release()` detaches that finalizer and calls `mobile_stack_raw_samples_release` exactly once.
- `NativeFinalizer.attach(... externalSize: samples.lengthInBytes)` reports the native allocation size to Dart's GC heuristics while the lease is alive.
- `runPhase2ValidatedJob` transfers the lease to `PipelineContext`.
- In Work297's file-backed demosaic path, after `_spillCalibratedRawForDemosaic` has completed and the in-memory mosaic references are cleared, `releaseRawSampleStorage()` explicitly releases the native FP32 allocation before the tiled demosaic loop begins.
- `PipelineContext.clearTransientData()` also calls the same idempotent release hook, covering cancellation/error paths before the normal spill-release point.

## Quality invariants
No sensor sample, black-level, white-level, camera-WB, dark/flat, defect correction, CFA phase, demosaic, registration, stacking or export formula was changed. Work298 changes only ownership/lifetime after the calibrated samples have already been copied to the file-backed store.

## Memory impact
The released native allocation is exactly `pixelCount * 4` bytes: about 132 MB for 33 MP and 240 MB for 60 MP. This bounds the lifetime of that allocation instead of waiting for a future GC. It is not evidence that Android process RSS will fall by exactly the same number immediately; allocator/page reclamation requires device measurement.

## Validation
- Source wiring/static checks: performed.
- Native Release CMake build: performed.
- Native CTest: performed; results recorded in the handoff.
- Flutter/Dart analyze/tests/APK: not run because this environment has no Dart/Flutter SDK.
- Android device RSS/thermal profiling: not run.
