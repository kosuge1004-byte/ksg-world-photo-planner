# Work308 — Streamed RAW calibration FP32 parity fix

## Confirmed discrepancy
The established in-memory Phase2 calibration mutates a Float32List at every
stage:
1. LinearizationTable
2. BlackLevel/DeltaH/DeltaV subtraction
3. Master Dark subtraction
4. WhiteLevel normalization/clamp
5. Camera white balance
6. Master Flat correction

Therefore each following stage consumes the Float32-rounded result of the
previous stage.

Work301–Work307 `calibrateStreamedRawToStore()` fused those stages in one Dart
`double value` and wrote Float32 only at the end.  That is not numerically
identical, even though formulas/order matched.

## Work308 fix
`calibrateStreamedRawToStore()` now stores into the row Float32List and reloads
after every established stage boundary.  This mirrors the production
in-memory arithmetic by construction without restoring a full-frame RAW heap
allocation.

## Saturation timing correction
The established Phase2 rebuilds source saturation immediately after
LinearizationTable.  Work307 initialized saturation from the pre-linearized
stored value.

Work308 evaluates the WhiteLevel threshold after the optional linearization
stage (after its Float32 write-back), matching the established Phase2 timing.

## Tests added/updated
- Existing streamed-vs-established calibration parity test now rebuilds the
  expected saturation mask after linearization.
- The parity fixture uses non-trivial linearization values to exercise
  intermediate FP32 rounding.
- A focused test verifies that saturation can be introduced by a
  LinearizationTable and is detected by the streamed path.

## Validation available here
- Static source checks.
- Native tree unchanged from Work307.
- ZIP CRC PASS.
- Dart/Flutter SDK unavailable, so parity tests/analyze/APK/device validation
  remain unexecuted.
