# Work164 — CFA Drizzle -> Linear DNG Transparency Mask

Status: WIP.

## Implemented

### Direct RGB CFA Drizzle export
- Builds a DNG transparency mask directly from the existing per-channel
  drizzle coverage store.
- A pixel is valid only when R, G and B each have their own coverage at or
  above the same `minimumCoverage` already used by the gap-fill stage.
- Gap-filled RGB values remain available in the output image, but the DNG mask
  records that they were synthesized rather than source-supported in all three
  planes.
- No new coverage threshold was introduced.

### Native-CFA reconstruction + real demosaic export
- Reads only the physically sampled CFA plane at each native sensor position.
- A source CFA position is invalid when:
  - its native-plane coverage is below the same `minimumCoverage`, or
  - the reconstructed mosaic's existing saturation/invalid mask marks it.
- The invalid source mask is expanded by exactly
  `MobileStackAdaptiveDemosaicEngine.requiredInputRadius` (currently 4 CFA
  pixels), matching the production demosaic engine's documented input support.
- Final RGB DNG validity is therefore based on the actual source support that
  can influence each demosaiced output pixel.

### Generic Linear DNG export
- `exportTileStoreToImage` now accepts either:
  - the normal-stack exact `contributionStore`, or
  - an exact precomputed `linearDngTransparencyMask`.
- Supplying both is rejected.
- The precomputed mask size must exactly match output dimensions.
- Normal Milky Way Work163 behavior remains unchanged.

## Independent DNG structure validation
CFA-derived masks were embedded into both Classic DNG and 64-bit DNG reference
files and parsed independently with `tifffile`.

Classic DNG:
- 1 main IFD + 1 transparency-mask SubIFD
- main image Float32
- transparency mask uint8
- mask NewSubFileType = 4
- mask PhotometricInterpretation = 4
- parser warnings = 0

64-bit DNG:
- recognized as BigTIFF
- 1 main IFD + 1 transparency-mask SubIFD
- main image Float32
- transparency mask uint8
- mask NewSubFileType = 4
- mask PhotometricInterpretation = 4
- parser warnings = 0

Reference coverage produced mask `[255, 0, 255, 0]`, read back unchanged.

## Executed validation
- Node/reference suite: 419/419 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Direct RGB coverage-mask regression: passed.
- Native-CFA sampled-plane regression: passed.
- Exact radius-4 demosaic influence regression: passed.
- Existing reconstructed saturation/invalid union regression: passed.
- CFA export source-contract tests: passed.
- Independent Classic/BigTIFF DNG parser validation: passed.

## Remaining limits
- Flutter/Dart SDK is unavailable in this environment, so Dart compile,
  `dart analyze`, Flutter tests, and APK build remain unexecuted.
- Lightroom / Camera Raw interoperability with an actual app-generated Work164
  file remains unverified.
- The transparency mask is binary source-validity information. It does not yet
  store the exact contribution/coverage magnitude as a separate diagnostic
  image or metadata plane.
