# Work160 — Quality-first certain change: CFA flat normalization

Status: WIP.

## Implemented
- Master-flat normalization is now per CFA color plane:
  - Red separately
  - both Green phases combined
  - Blue separately
- Per-pixel median combination is unchanged.
- Spatial flat structure (vignetting/dust) remains in the correction map.
- Flat-source color / Bayer channel sensitivity ratios are no longer converted
  into a false multiplicative color correction.
- Non-finite combined-flat samples are rejected explicitly.

## Evidence
Siril documents `-equalize_cfa` as equalizing the mean intensity of the RGB
layers of a CFA master flat specifically to avoid tinting the calibrated image.
This change implements the same quality principle in the existing Bayer RAW
calibration architecture.

## Validation
- Node/reference suite: 377/377 passed.
- Native clean CMake build: passed.
- Native CTest: 8/8 passed.
- Added explicit regression:
  a uniform RGGB flat with R=200, G=100, B=50 normalizes all samples to 1.0.
- Added spatial-gradient regression:
  the same left/right vignette factor remains identical across CFA colors.
- Flutter/Dart SDK unavailable: Dart tests/analyze/APK not executed.
