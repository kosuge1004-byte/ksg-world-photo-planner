# Work191 — Robust local-registration quality bundle

Baseline: Work190
Date: 2026-08-21

## Goal
Prioritize image quality without changing RAW decode, calibration, demosaic, CFA drizzle accumulation, robust pixel combine, or Linear DNG serialization.

## 1. Local residual correction is robust against sparse star mismatches

The existing local-registration field used a degree-2 polynomial, normalized coordinates, a minimum of 24 matches at the default setting, and a hard 3-pixel correction cap. However, all accepted star matches were fed directly to ordinary least squares. A sparse mismatched star could therefore bias the smooth spatial correction field.

Work191 keeps the same low-degree model and all existing safety bounds, but adds one robust re-fit pass:
1. fit the existing polynomial to all residual matches;
2. compute each match's 2-D residual-vector error against that smooth field;
3. estimate robust center/spread using median + MAD (1.4826 scale);
4. reject only sparse errors beyond center + 4.5 sigma;
5. re-fit the same degree-2 field from survivors;
6. if clipping would leave fewer than the original minimum required constraints, retain the original all-match fit instead of under-constraining the model.

This is intentionally conservative: it does not increase polynomial degree, correction cap, or local freedom.

## 2. Highest-quality CFA path now defaults local registration ON

Before Work191, the high-quality pipeline already defaulted to:
- PSF centroid refinement ON;
- comprehensive frame-quality weighting ON;
- robust CFA outlier rejection ON;

but local residual registration remained OFF in the UI/background path.

After robustifying the local fit, Work191 makes local registration ON by default for the highest-quality CFA path, while retaining the existing UI switch so it can still be disabled explicitly.

## 3. Deliberately unchanged

- `outputScale=2` remains unchanged.
- The `useRealDemosaic` path remains restricted to `outputScale=1` and is NOT force-enabled.
- No claim is made that outputScale=1 real-demosaic is superior to outputScale=2 CFA drizzle without real-RAW/Adobe A-B evidence.
- RAW decode/calibration/demosaic/native code unchanged.
- Robust pixel rejection thresholds unchanged.
- CFA drizzle pixfrac unchanged.
- Linear DNG writer/metadata unchanged.

## Validation executed here

- Node/reference/source-contract tests: 500/500 PASS.
- Added independent numerical regression: one sparse mismatched-star residual is rejected and the known quadratic residual field is recovered by the robust re-fit.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 verified.
- Native ASan/UBSan CTest: 8/8 PASS.
- Mechanical diff from Work190 confirms no `native/`, RAW decoder, demosaic, CFA accumulator, robust pixel-combine, or Linear DNG writer changes.

## Still not verified

This runtime has no Flutter/Dart SDK or adb. Therefore these remain pending for Codex/local environment:
- flutter pub get
- flutter analyze
- flutter test
- Android arm64 APK build
- Pixel 9 Pro real-RAW background/process-death test
- real RAW A/B comparison of local registration ON/OFF
- real RAW outputScale=2 vs outputScale=1+real-demosaic comparison
- Adobe Lightroom/Camera Raw Linear DNG interoperability

Do not mark those items PASS until actually executed.
