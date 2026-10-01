# Work180 — DNG metadata consistency

Status: WIP.

## Reference
Adobe currently publishes DNG Specification 1.7.1.0 and DNG SDK 1.7.1
Build 2611 (June 9, 2026).

## Corrected
The writer previously declared DNGVersion 1.4.0.0 and DNGBackwardVersion
1.4.0.0. The file's baseline LinearRaw/TIFF structures do not require a
1.4-only decoding feature.

- DNGVersion remains 1.4.0.0.
- DNGBackwardVersion is now 1.1.0.0.
- Classic TIFF and BigTIFF paths use the same declaration.

## Audited and unchanged
Classic and BigTIFF remain aligned for LinearRaw, BlackLevel, WhiteLevel,
ColorMatrix1, AsShotWhiteXY, D65 CalibrationIlluminant1,
ColorimetricReference, DefaultBlackRender, ActiveArea and DefaultCrop.

No camera-specific metadata was guessed.

## Limitation
Source consistency does not prove Adobe interoperability. A generated DNG
still needs Adobe DNG SDK/Converter plus Lightroom/Camera Raw import testing.

## Validation
- Node/reference/source-contract: 73/73 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK and Adobe applications unavailable here.
