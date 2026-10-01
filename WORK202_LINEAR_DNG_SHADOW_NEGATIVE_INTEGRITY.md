# Work202 — Linear DNG shadow / negative-value integrity

Date: 2026-08-21
Baseline: Work201
Priority: maximum image quality / no unjustified clipping

## Adobe DNG 1.7.1 findings

Adobe DNG 1.7.1 defines the raw-to-linear mapping as linearization, black subtraction,
normalization and clipping. Linear reference zero-light is 0.0. Values above 1.0 should
be clipped, while values below 0.0 may be clipped; however Adobe explicitly recommends
preserving negative values for at least the early rendering stages because this can improve
shadow noise reduction.

BlackLevel tag 50714 permits SHORT, LONG or RATIONAL. Its default is 0.
WhiteLevel for floating-point images has a defined default of 1.0.
DefaultBlackRender=1 means the converter should not perform additional rendering-time
black subtraction.

Official specification:
https://helpx.adobe.com/content/dam/help/en/camera-raw/digital-negative/jcr_content/root/content/flex/items/position/position-par/download_section_733958301/download-1/DNG_Spec_1_7_1_0.pdf

## Defect found in Work201

The Linear DNG writer explicitly emitted BlackLevel=0 using TIFF DOUBLE type.
DOUBLE is not a permitted DNG type for BlackLevel. The numeric value was correct, but the
tag encoding was not specification-compliant.

## Work202 correction

- Omit BlackLevel entirely in both Classic TIFF DNG and BigTIFF DNG.
- Rely on the DNG-defined BlackLevel default of 0, which exactly matches the already
  black-calibrated stack.
- Continue omitting WhiteLevel for Float LinearRaw so the DNG-defined floating-point
  default of 1.0 applies.
- Preserve finite negative scene-linear Float32 samples; do not clamp them to zero in the
  writer.
- Keep DefaultBlackRender=1 (None), preventing an additional image-dependent rendering
  black subtraction after our calibrated stack.
- Keep the Work201 highlight headroom/BaselineExposure scheme unchanged.

## Important limitation

The DNG specification permits readers to clip negative linear-reference values to zero,
although it recommends preserving them in early rendering. Therefore Work202 can preserve
negative information in the file, but cannot guarantee that every third-party DNG reader
will retain it internally. Adobe Lightroom/Camera Raw real-file verification remains a
later mandatory test.

## Quality-pipeline changes

NONE to RAW decode, calibration mathematics, registration, local registration,
CFA Drizzle accumulation, robust combine, gap-fill algorithm, demosaic algorithm,
color-transform coefficients or tone mapping.

## Verification

- Node all `.test.mjs`: 516 / 516 PASS
- Native Release CTest: 8 / 8 PASS
- Native ABI exports: 10 PASS
- ASan/UBSan CTest: 8 / 8 PASS
- Flutter analyze/test: NOT RUN (Flutter SDK unavailable in this environment)
- Android APK / Pixel real RAW: NOT RUN
- Adobe Lightroom / Camera Raw real DNG read: NOT RUN
