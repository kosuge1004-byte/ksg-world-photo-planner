# Work307 — Detection-stage full-frame memory hardening

## Confirmed Work306 production peaks

### Meteor analysis
`analyzeDecodedFrames()` read an entire file-backed RGB frame into one
`LinearRgbTile`, then copied its green channel into a full-resolution
`LuminancePlane`.

For 60 MP:
- RGB Float32 tile: 60M * 3 * 4 = ~720 MB decimal
- green Float32 plane: 60M * 4 = ~240 MB decimal

Those could coexist during detection. The ~960 MB arithmetic is source-derived,
not measured Android RSS.

### CFA Drizzle registration
When a calibrated CFA frame already existed in
`FileBackedLinearRawMosaicStore`, star detection called `readFull()` and then
constructed a second full-resolution green Float32 plane.

For 60 MP:
- materialized CFA Float32: ~240 MB
- green Float32 plane: ~240 MB

## Work307 changes

### Meteor
Both meteor analysis passes now build the exact same green channel directly
from bounded RGB row strips. The required full-resolution green plane remains,
but the simultaneous full-resolution 3-channel RGB tile is removed.

### CFA Drizzle
Prepared file-backed CFA frames now generate the same green registration plane
directly from row strips with one-row vertical halo. Optional phase-scale
harmonization is applied to Float32 strip samples before interpolation, keeping
the old Float32 rounding boundary. Saturation influence is built directly as a
packed one-bit-per-pixel mask from bounded saturation regions.

The in-memory fallback remains for callers/frames that do not already have a
prepared file-backed store.

## Quality invariants
- Meteor uses exactly the demosaiced green sample at every pixel, as before.
- CFA native green sites remain exact samples.
- CFA red/blue proxy sites use the same orthogonal-green average.
- Same edge-neighbor handling.
- Same phase index `((y & 1) << 1) | (x & 1)`.
- Same saturation-influence geometry.
- Star/streak detector algorithms and thresholds are unchanged.

## Validation
- Static production wiring checks performed.
- CFA file-backed vs in-memory parity test source added.
- Native tree unchanged from Work306.
- ZIP CRC PASS.
- Dart/Flutter SDK unavailable; Dart test/analyze/APK/device RSS not run.
