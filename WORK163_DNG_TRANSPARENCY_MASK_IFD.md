# Work163 — Linear DNG Transparency Mask IFD

Status: WIP.

## Implemented

### Normal Milky Way Linear DNG
- Uses Work161 exact post-kappa-sigma RGB survivor counts.
- Work162 converts those counts into one byte per output pixel:
  - 255 = R/G/B all have at least one surviving observation
  - 0 = one or more channels have no surviving observation
- `exportTileStoreToImage` now accepts the exact contribution store.
- Both normal Milky Way export paths pass `result.contributionStore`.
- The DNG export path builds the transparency mask from contribution counts.
- No output brightness test is used; valid linear black remains valid.

### DNG writer
- Classic TIFF/DNG and 64-bit DNG/BigTIFF both support a second IFD:
  - NewSubFileType = 4
  - PhotometricInterpretation = 4
  - SamplesPerPixel = 1
  - BitsPerSample = 8
  - Compression = none
- The main IFD uses TIFF/DNG SubIFDs (tag 330) to reference the transparency-mask IFD; main NextIFD remains zero.
- The mask IFD is written after the Float32 main-image strips.
- BigTIFF mask IFD is 8-byte aligned.
- Classic mask offsets are checked against uint32 limits.
- Automatic classic-vs-BigTIFF selection includes mask byte size.

## Independent file-structure validation
Synthetic reference files were generated for both containers and parsed with
`tifffile`.

Classic DNG:
- 1 main IFD + 1 transparency-mask SubIFD
- page 0: 2x2x3 Float32 LinearRaw
- page 1: 2x2 uint8 transparency mask
- NewSubFileType = 4
- PhotometricInterpretation = 4
- parser warnings = 0

64-bit DNG:
- recognized as BigTIFF
- 1 main IFD + 1 transparency-mask SubIFD
- page 0: 2x2x3 Float32 LinearRaw
- page 1: 2x2 uint8 transparency mask
- NewSubFileType = 4
- PhotometricInterpretation = 4
- parser warnings = 0

Reference mask `[255, 0, 255, 0]` was read back unchanged.

## Executed validation
- Node/reference suite: 413/413 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Independent Classic DNG parser validation: passed.
- Independent 64-bit DNG parser validation: passed.
- Dart writer source-contract tests: passed.
- Milky Way contribution-store wiring contract: passed.

## Remaining limits
- Flutter/Dart SDK is unavailable in this environment, so Dart compile,
  `dart analyze`, Flutter tests, and APK build remain unexecuted.
- Lightroom / Camera Raw interoperability with an actual app-generated Work163
  file is still unverified.
- CFA Drizzle does not yet export an equivalent final contribution-derived
  transparency mask; Work163 wires this only for the normal Milky Way
  kappa-sigma result where exact survivor counts are already preserved.
