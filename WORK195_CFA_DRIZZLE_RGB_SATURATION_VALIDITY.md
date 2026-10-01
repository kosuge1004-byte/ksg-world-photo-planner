# Work195 — CFA Drizzle direct-RGB saturation validity hardening

## Goal
Preserve highlight/star-core integrity in the highest-quality supersampled CFA Drizzle path without changing RAW decode, calibration, registration, drizzle accumulation, robust value combination, gap-fill interpolation, color transform, or Linear DNG serialization.

## Problem found
The native-CFA reconstruction path (`outputScale == 1` + real demosaic) already propagated saturation coverage into its reconstructed invalid mask. The direct RGB CFA Drizzle path (used by the supersampled/highest-quality path) built its Linear DNG transparency mask only from non-saturated source coverage.

That asymmetry meant a final RGB pixel could remain marked valid even when one color plane was saturated in a majority of its observed coverage, as long as a smaller non-saturated survivor remained after robust rejection. For bright star cores/highlights this can present a reconstructed value as fully valid even though the observations indicate clipping.

## Work195 change
`buildCfaDrizzleRgbTransparencyMask` now optionally consumes:
- survivor non-saturated coverage;
- saturated coverage;
- pre-rejection non-saturated decision coverage.

For every R/G/B channel, the final pixel remains valid only if:
1. survivor source coverage reaches the existing `minimumCoverage`; and
2. when saturation coverage is available, the saturated fraction is below the same 0.5 majority rule already used by native-CFA reconstruction.

For the robust-rejection path, the denominator uses pre-rejection non-saturated decision coverage plus saturated coverage. This preserves Work190's correction: robustly rejected non-saturated observations are not allowed to falsely inflate the apparent saturated fraction.

If saturation stores are absent, behavior is unchanged from Work194.

## Why this is quality-preserving
This does not modify RGB sample values or interpolate new data. It only prevents majority-saturated source observations from being advertised as fully valid Linear DNG pixels in the direct supersampled RGB path.

## Regression evidence in this environment
- Node all tests: 508/508 PASS
- Native Release CTest: 8/8 PASS
- Native ABI exports: 10 verified
- Native ASan/UBSan CTest: 8/8 PASS
- Work194 -> Work195 production-code changes are limited to:
  - `lib/core/export/cfa_drizzle_dng_validity.dart`
  - `lib/core/session/cfa_drizzle_milky_way_export.dart`
- Node reference/test files updated to mirror the same saturation-validity contract.

## Not verified here
The current runtime still lacks Flutter/Dart/adb, so the following remain pending for Codex/device time:
- flutter pub get / lock regeneration
- flutter analyze
- flutter test
- Android arm64 APK build
- Pixel 9 Pro real-RAW test
- Adobe Lightroom/Camera Raw Linear DNG readback
- final outputScale=2 vs outputScale=1+real-demosaic A/B quality comparison
