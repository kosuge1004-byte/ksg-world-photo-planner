# Work201 — Linear DNG highlight-headroom preservation

## Purpose
Preserve positive scene-linear stack values above 1.0 without relying on DNG readers accepting out-of-range linear-reference values.

## Evidence-driven changes
- Float LinearRaw WhiteLevel tag is no longer written. DNG defines the floating-point default WhiteLevel as 1.0, while WhiteLevel's declared TIFF types are SHORT/LONG.
- Before DNG writing, transformed linear RGB is scanned for its maximum positive value.
- If max <= 1.0, storage is unchanged and BaselineExposure=0 EV.
- If max > 1.0, storage is divided by the smallest power of two that places all positive samples <= 1.0.
- The inverse number of stops is recorded as BaselineExposure, preserving the default exposure zero point while keeping recoverable highlight data inside the DNG linear-reference range.
- Power-of-two placement was chosen to avoid an arbitrary normalization factor and to minimize binary-rounding damage.
- No tone curve, LUT, local tone mapping, gamma, or hard highlight clip was added.

## Quality implications
This does not manufacture highlight detail. It preserves highlight detail already present in the stack that would otherwise be vulnerable to reader-side clipping above the DNG 1.0 linear-reference white point.

## Not changed
RAW decode, calibration, registration, local registration, CFA Drizzle accumulation, robust combine, gap fill, demosaic algorithm, and color transform coefficients.

## Verification in this environment
- Node .test.mjs: 514/514 PASS
- Native Release CTest: 8/8 PASS
- Native ABI exports: 10 PASS
- ASan/UBSan CTest: 8/8 PASS
- Flutter analyze/test/APK/Adobe Camera Raw import: NOT RUN (Flutter/Dart/adb/Adobe unavailable here)

## Required later validation
Open generated DNGs containing >1.0 pre-placement highlights in Adobe Camera Raw/Lightroom and verify that lowering Exposure recovers the stored highlight structure. Compare against an unscaled diagnostic export only for validation, not as production output.
