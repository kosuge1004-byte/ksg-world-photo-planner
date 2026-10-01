# Work294 — streamed master calibration memory hardening

## Verified pre-change issue
`prepareMasterDark()` and `prepareMasterFlat()` decoded every calibration RAW into a `List<LinearRawMosaic>` before combining it. Therefore N dark/flat files kept N complete Float32 CFA mosaics resident until master construction completed.

## Change
- Decode/calibrate one dark/flat RAW at a time.
- Immediately persist that calibrated CFA to `FileBackedLinearRawMosaicStore`.
- Combine source stores in 64-row chunks using the same non-saturated per-pixel median rule.
- Master-flat keeps its intermediate median plane in a temporary Float64 file, then performs the same CFA-plane mean normalization in a second streamed pass.
- Flat-specific dark subtraction now uses Work293's in-place subtraction because the decoded flat is exclusively owned at that point.
- Temporary files are disposed/deleted in `finally` blocks.

## Numerical contract
The median rule, saturated-site exclusion, invalid-site neutral values, CFA color grouping and flat normalization formula are unchanged. Final master storage remains Float32 exactly as before. No stacking/demosaic/output quality setting was changed.

## Memory effect
Before: approximately N complete calibration Float32 mosaics + output/intermediates were strongly referenced at once.
After: one decoded calibration mosaic at a time + file-backed sources + row chunks + final master. For flats, the former full-frame Float64 median remains Float64 but is file-backed rather than resident.

## Validation status
Static source inspection and ZIP CRC validation performed in this environment. Flutter/Dart SDK execution and device RSS measurement are not available here, so runtime compilation and actual RSS reduction remain unverified until build/device testing.
