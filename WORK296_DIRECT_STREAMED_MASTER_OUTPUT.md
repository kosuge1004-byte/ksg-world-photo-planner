# Work296 — Direct streamed Master Dark / Master Flat output

## Scope
Work295 removed long-lived Master Dark / Master Flat sample planes from the background light-frame phase, but the file-backed preparation wrappers still built one complete final `LinearRawMosaic` in RAM and only then wrote it to the file-backed store.

Work296 removes that last full-frame final-master materialization from the file-backed preparation path.

## Changes

1. `prepareMasterDarkStore()` now decodes calibration frames to the Work294 temporary source stores and combines them directly into the destination `FileBackedLinearRawMosaicStore` in 64-row chunks. It no longer calls `prepareMasterDark()` and therefore does not allocate a full final Master Dark `Float32List`.

2. `prepareMasterFlatStore()` now performs the median pass into the existing temporary Float64 median file, computes the unchanged CFA-color means, then normalizes and writes 64-row Float32 chunks directly into the destination store. It no longer allocates the final full-frame Master Flat `Float32List`.

3. `FileBackedLinearRawMosaicStore` supports incremental full-width row writes via `writeRows()` and a final `commitRowWrites()`. The store remains unreadable until commit, preserving the existing committed-store contract.

4. Empty `prepareMasterDarkStore()` input preserves the existing `InvalidDarkFrameInput` behavior; this was explicitly checked during the Work296 review to avoid changing public error semantics while removing the intermediate master.

5. Added source tests comparing direct-streamed Master Dark / Flat stores with the existing in-memory master APIs, including invalid-mask parity checks. These tests are present but cannot be executed in this environment because Dart/Flutter SDK is unavailable.

## Memory impact
For the file-backed background path, the final-master creation peak no longer requires one complete final Float32 sample plane in RAM. The removed allocation is approximately:
- 33 MP: 132 MB decimal (~126 MiB)
- 60 MP: 240 MB decimal (~229 MiB)

Active final-output memory is instead bounded to `width × up to 64 rows × 4 bytes` for Dark, and the same Float32 output chunk plus a 64-row Float64 median read chunk for Flat. A full-image one-bit invalid mask remains (~7.5 MB for 60 MP), because the file-backed store commits the validity mask after all rows are known.

Exact Android process RSS reduction is not measured here. Dart GC timing, LibRaw/native allocations, filesystem page cache, and allocator behavior affect observed RSS.

## Quality invariants
Unchanged:
- per-pixel median rule and even-count averaging
- rejection of saturated/invalid calibration samples
- Master Dark invalid-site output value and mask semantics
- Master Flat invalid-site unity value and mask semantics
- CFA-specific flat normalization means
- Float64 median/intermediate accumulation for flat normalization
- final Float32 master precision
- dark/flat formulas used on light frames
- CFA geometry, demosaic, registration, stack/rejection, and output math

The change is storage lifetime/I/O granularity only.

## Verification status
- Source diff reviewed against Work295: PASS.
- Structural/static verification script: PASS.
- ZIP CRC/integrity: to be recorded after packaging.
- Dart/Flutter tests: NOT RUN (SDK unavailable).
- APK build: NOT RUN (SDK unavailable).
- Device RSS/CPU/thermal measurement: NOT RUN.
