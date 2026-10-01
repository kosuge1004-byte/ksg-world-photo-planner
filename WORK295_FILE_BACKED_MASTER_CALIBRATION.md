# Work295 — File-backed Master Dark / Master Flat

## Scope
Work294 already bounded the memory used while *building* master calibration frames, but the completed Master Dark and Master Flat were still retained as full-frame `LinearRawMosaic` / `Float32List` objects for the entire background light-frame run.

Work295 removes that long-lived residency from the Android background standard-stack/star-trail path without changing calibration mathematics.

## Changes

1. Added file-backed calibration application functions:
   - `subtractDarkFrameFromStoreInPlace()`
   - `applyFlatFieldCorrectionFromStoreInPlace()`

   They read the existing `FileBackedLinearRawMosaicStore` in 64-row chunks and update the exclusively-owned light-frame Float32 CFA plane in place.

2. Added file-backed master preparation APIs:
   - `prepareMasterDarkStore()`
   - `prepareMasterFlatStore()`

   The full master created by the existing Work294 combiner is immediately persisted to a temporary store and does not escape the preparation function. When a dark is used to prepare flats, `prepareMasterFlatStore()` can subtract directly from the file-backed dark store in chunks.

3. Extended the Phase-2 quality pipeline to accept either the existing in-memory masters or file-backed masters. Supplying both representations for the same master is rejected.

4. Switched `standard_stack_background_worker.dart` to file-backed masters and disposes both stores in `finally`.

5. Added `test/file_backed_master_calibration_test.dart` comparing the file-backed dark/flat correction results and invalid masks against the existing in-memory in-place implementations.

## Memory impact
During the long light-frame phase, a completed master no longer requires a full-frame Float32 sample plane in RAM.

Approximate Float32 sample-plane residency removed per master:
- 33 MP: ~132 MB decimal (~126 MiB)
- 60 MP: ~240 MB decimal (~229 MiB)

With both Master Dark and Master Flat enabled, the long-lived sample-plane reduction is therefore approximately twice that amount. Exact process RSS reduction must be measured on-device because Dart GC, LibRaw/native buffers and allocator behavior affect observed RSS.

The active file-backed read chunk is only `width × up to 64 rows × 4 bytes` plus its small packed validity data.

## Quality invariants
Unchanged:
- Float32 light/master sample precision
- Dark formula and signed-negative preservation
- Master-dark invalid/saturated-site pass-through semantics
- Flat division formula
- `minimumFlatValue = 0.05`
- Invalid-mask propagation
- CFA geometry
- Demosaic / registration / stacking / output paths

The optimization changes storage lifetime and I/O granularity only.

## Scope limitation
File-backed master hot/cold-pixel detection is deliberately not silently emulated. If that optional cosmetic detector is requested with only a file-backed master, the factory rejects the unsupported combination rather than changing behavior. The current standard background call keeps these optional detectors disabled, as before.

## Verification status
- Modified-source structural checks: PASS.
- ZIP CRC/integrity: PASS after packaging.
- Added Dart parity tests: source added, but not executable in this environment because Dart/Flutter SDK is unavailable.
- APK build / Android device RSS measurement: NOT VERIFIED here.
