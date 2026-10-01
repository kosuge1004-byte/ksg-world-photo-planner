# Work200 — DNG specification compliance / quality audit

Date: 2026-08-21
Baseline: Work199
Priority: maximum image quality; do not trade quality for compatibility or speed without evidence.

## Changes made

### 1. DNGBackwardVersion corrected to 1.4.0.0

The Linear DNG main IFD is 32-bit IEEE floating-point. Adobe DNG 1.7.1.0 Appendix A states that floating-point image support was added in DNG 1.4.0.0 and writers should set DNGBackwardVersion to at least 1.4.0.0. Transparent-pixel IFDs (NewSubFileType=4) also require at least 1.4.0.0.

Work199 declared DNGVersion 1.4.0.0 but DNGBackwardVersion 1.1.0.0. Work200 changes the backward version to 1.4.0.0 for both classic TIFF and BigTIFF Linear DNG output.

Official specification:
https://helpx.adobe.com/content/dam/help/en/camera-raw/digital-negative/jcr_content/root/content/flex/items/position/position-par/download_section_733958301/download-1/DNG_Spec_1_7_1_0.pdf
Appendix A, Compatibility Issues 8 and 9.

BigTIFF does not require a different DNG version: the DNG specification explicitly states 64-bit format support is independent of the DNG version.

### 2. ColorimetricReference corrected to scene-referred

The Linear DNG path deliberately avoids creative tone/gamut mapping and writes scene-linear, white-balanced synthetic camera coordinates. Work199 wrote ColorimetricReference=1, which the DNG specification defines as output-referred using the ICC profile perceptual dynamic range.

Work200 writes ColorimetricReference=0, defined by the DNG specification as scene-referred. This matches the actual processing contract. AsShotWhiteXY remains D65 because the synthetic stored coordinates are already white-balanced to D65.

Official specification: DNG 1.7.1.0, ColorimetricReference tag description.

## Not changed

- RAW decode
- calibration
- defect correction
- star detection
- global registration
- local registration
- frame-quality weighting
- CFA Drizzle accumulation
- robust rejection/combine
- gap filling
- production native demosaic
- linear RGB color transform arithmetic
- Linear DNG Float32 sample data
- black/white sample values
- transparency mask construction

## Verification run in this environment

- Node `.test.mjs` files discovered under `tool/**/test`: 508/508 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 verified.
- Native ASan/UBSan CTest: 8/8 PASS.
- Flutter/Dart SDK: unavailable in this runtime, therefore flutter analyze/test/build remain NOT RUN.
- adb / Pixel 9 Pro: unavailable in this runtime, therefore device validation remains NOT RUN.
- Adobe Camera Raw / Lightroom real-file open test: NOT RUN.

## Important remaining DNG quality question for Work201+

The writer intentionally preserves finite negative values and permits positive Float32 samples above 1.0. Adobe DNG's raw-to-linear-reference model states that linear reference values map maximum useful signal to 1.0 and rescaled values above 1.0 should be clipped to 1.0 by a reader. Therefore, pre-converted synthetic RGB values above 1.0 require a dedicated design review before claiming that all over-range highlight/color information survives a compliant DNG reader.

Do NOT solve this by blindly clipping samples in the writer. That would only make the loss explicit. The correct solution must preserve scene-linear information and must be validated with DNGValidate/Adobe Camera Raw or equivalent real DNG reader behavior. This remains OPEN.

## Evidence discipline

Work199 reported 514/514 Node tests. Work200 re-enumerated the actual `tool/**/test/*.test.mjs` files and executed them; the actual current run contains 508 tests. Work200 records 508/508 and does not carry forward an unexplained count.
