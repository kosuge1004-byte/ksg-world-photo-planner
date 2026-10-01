# Work310 — Final code-side hardening / release-candidate audit

## Concrete Work309 defect fixed
`lib/core/registration/star_detector.dart` used `Float64List` after Work309
without importing `dart:typed_data`. Work310 adds the missing import. This was a
real compile-risk found by source inspection, not a hypothetical optimization.

## CFA Drizzle real-demosaic DNG validity
The production real-demosaic Linear DNG path still called
`buildCfaDrizzleDemosaicTransparencyMask()`, which materialized:
- sourceInvalid Uint8: 1 byte/pixel
- packed RawSaturationMask after conversion
- dilated packed mask
- final transparency Uint8: 1 byte/pixel

Work310 changes the production path to
`CfaDrizzleDemosaicTransparencyMaskSource`.

It reads only the requested DNG mask rows plus the exact demosaic support halo,
builds a one-bit invalid map for that bounded block, and evaluates the same
Chebyshev-radius invalid influence. No full-image validity plane is retained.

The legacy full builder remains as a reference/test API.

## Quality semantics
No reconstruction, demosaic, registration, stacking, rejection, tone, or export
color equation was changed in this batch.

For the CFA validity mask:
- same native-CFA channel selection
- same `coverage < minimumCoverage`
- same union with reconstructed saturation/invalid state
- same Chebyshev support radius supplied by the production demosaic backend
- same output encoding: invalid=0, valid=255

A parity test compares the streaming source to the legacy full builder,
including edges, low-coverage sites, additional invalid sites, radius=2, and
non-uniform row request sizes.

## Remaining intentional full-resolution data
After Work287–Work310, grep still finds old/reference APIs and algorithm-owned
planes. The principal production residual that is not removed here is the
single-channel full-resolution detection plane used by the current star/streak
algorithms. At 60 MP Float32 this is ~240 MB decimal. Removing it without
changing detector behavior requires a separate row-addressable/asynchronous
detector architecture and materially increases random I/O/CPU risk.

JPEG display export also still depends on the Dart `image` encoder's complete
RGB8 image object. At 60 MP its raw RGB8 payload is ~180 MB decimal. TIFF16,
BMP and Linear DNG already have streaming/file-backed export paths. Replacing
JPEG safely requires introducing and validating a native incremental JPEG
encoder; it is not mixed into this release-candidate batch because that changes
a platform ABI/dependency at the end of a quality-first hardening sequence.

Those two items are explicit residual implementation constraints, not hidden
or claimed fixed.

## Validation performed in this environment
- source-level production wiring checks
- typed-data import scan
- rough delimiter-balance scan
- residual full-plane allocation scan
- native tree comparison
- native CMake/CTest attempted separately
- ZIP CRC

Dart/Flutter SDK is not installed in this execution environment. Therefore
`dart analyze`, Flutter tests, APK build, and Android device RSS/thermal/ANR
validation cannot be truthfully marked PASS here.

## Host-native test execution
- CMake configure: PASS
- Native host build: PASS
- CTest: NOT ALL PASS. See WORK310_NATIVE_HOST_TEST_RESULTS.txt for exact failing test/output.
- Changed-file delimiter scan: PASS
