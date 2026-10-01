# Work303 — CFA Drizzle reconstructed-CFA full-plane memory removal

## Confirmed Work302 bottleneck
`reconstructNativeCfaMosaicFromDrizzleTiled()` still allocated:
- 3 × full-image Float64 value planes
- 3 × full-image Float64 coverage planes
- optional full-image Float32 saturation coverage
- optional full-image Float32 decision coverage
- final full-image Float32 CFA
- temporary one-byte-per-pixel saturation flags

For a 60 MP image, the six Float64 planes alone are about 2.88 GB decimal.
This was code-derived allocation size, not an observed Android RSS figure.

## Work303 production-path change
The real-demosaic CFA Drizzle export path now uses
`reconstructNativeCfaStoreFromDrizzleStreamed()`.

It:
- reads full-width row strips plus `kernelRadius` halo rows,
- applies the same selected-CFA-channel gap-fill rule,
- writes final Float32 CFA rows directly to `FileBackedLinearRawMosaicStore`,
- builds saturation as a packed one-bit-per-pixel mask,
- feeds the resulting store directly into `demosaicFileBackedRawMosaic()`.

The legacy in-memory/tiled reconstruction function remains unchanged for
reference tests and non-production callers.

## Quality invariants
- Same CFA channel selection at absolute (x,y).
- Same own-coverage threshold.
- Same inclusive square neighbor search and coverage-weighted average.
- Same edge clamping.
- Same zero fallback when no covered neighbor exists.
- Same saturation fraction rule.
- Same production native demosaic and tile geometry.

## Validation available in this environment
- Static wiring checks.
- Source parity test added (legacy vs streamed reconstruction).
- ZIP CRC test.
- Dart/Flutter SDK unavailable: analyzer/test/APK/device RSS remain unverified.
