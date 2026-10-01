# Work167 — Linear DNG colorimetric semantics correction

Status: WIP.

## Quality-critical issue
The exported pixel raster is explicitly transformed into white-balanced
linear sRGB/D65 before being written. Previous metadata still described it
with scene-referred camera-style semantics:
- ColorMatrix1 present
- CalibrationIlluminant1 = D65
- AsShotNeutral = [1,1,1]
- default ColorimetricReference (scene referred)

Adobe DNG SDK states that when ColorimetricReference is ICC Profile PCS,
the data must already be white balanced, AsShotNeutral is not allowed, and
AsShotWhiteXY is the PCS white point.

## Implemented
For both Classic DNG and 64-bit DNG:
- ColorimetricReference (50879) = 1, ICC Profile PCS/output referred.
- Removed AsShotNeutral (50728).
- Added AsShotWhiteXY (50729) = D65 x=0.3127, y=0.3290.
- Kept the existing XYZ->linear-sRGB ColorMatrix1 and D65 calibration
  illuminant, matching the stored linear-sRGB/D65 sample space.
- Pixel samples are unchanged.
- Exposure, white-point scaling, profile LUTs and tone curves remain forbidden
  in the Linear DNG export path.

## Why this is quality relevant
Incorrect white/color semantics can make a RAW converter apply an additional
camera-neutral/white-balance interpretation to samples that are already white
balanced. This change makes the metadata describe the actual stored samples
instead of pretending they are untouched camera RGB.

## Executed validation
- Node/reference/source-contract suite: 425/425 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.

## Still unverified
- Flutter/Dart SDK compile/analyze/tests/APK.
- Adobe DNG Validator.
- Lightroom/Camera Raw rendering of an actual app-generated Work167 DNG.
