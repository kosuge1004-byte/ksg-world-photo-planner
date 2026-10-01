# Work160 Quality Batch — Linear DNG Output Foundation

Status: WIP. Flutter/Dart SDK tests, dart analyze, APK build, and real-editor interoperability are still unexecuted in this environment.

## Goal
Make Linear DNG the quality-first final output while keeping TIFF/BMP as compatibility/auxiliary outputs.

## Implemented
- Added `OutputImageFormat.linearDng` and made it the default `ProcessingSession` output.
- Added a dedicated 32-bit IEEE Float LinearRaw DNG writer.
- DNG main image:
  - PhotometricInterpretation = LinearRaw (34892)
  - 3 channels, 32-bit IEEE float
  - DNGVersion / DNGBackwardVersion = 1.4.0.0
  - Orientation = top-left
  - synthetic UniqueCameraModel = `MobileStack Linear sRGB`
  - ColorMatrix1 = D65 XYZ -> linear sRGB
  - CalibrationIlluminant1 = D65
  - AsShotNeutral = 1,1,1
  - DefaultBlackRender = None
- Linear DNG stores signed and >1.0 linear Float32 values without display-tone quantization.
- Added atomic `linearDngColorTransform` to `DngFinalRenderProfile`.
- Linear DNG export deliberately does not bake:
  - BaselineExposure
  - auto exposure / white point
  - ProfileHueSatMap
  - ProfileLookTable
  - ProfileToneCurve
  - local tone adaptation
  - sRGB transfer/gamma
- CFA Drizzle output is switched to Linear DNG and bypasses local tone.
- Result/save/share paths recognize `.dng` and its MIME type.
- Added DNG-specific result-screen notice instead of attempting an inline bitmap preview.
- Existing TIFF16/BMP writers remain available.

## Executed validation
- Node reference/regression suite: 372/372 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Independent reference DNG parsed with `tifffile`:
  - shape 2x2x3
  - dtype float32
  - PhotometricInterpretation 34892
  - SampleFormat IEEEFP x3
  - DNGVersion 1.4.0.0
  - UniqueCameraModel present
  - DefaultBlackRender = None
  - negative value -0.25 preserved
  - overrange value 4.0 preserved
  - parser warnings: none
- Static output-format/export-path contract checks: passed.

## Known limits before release
- Flutter/Dart code has not been compiled or tested because the SDK is unavailable here.
- Current Linear DNG writer is classic TIFF-offset DNG only. Outputs exceeding the uint32/classic-TIFF range are rejected; BigDNG remains to be implemented.
- EXIF/original capture metadata and an embedded rendered preview/thumbnail are not yet copied into the synthetic result DNG.
- Interoperability with Lightroom / Camera Raw / other real RAW editors has not yet been tested.
- Therefore this is not yet a production-verified DNG writer.
