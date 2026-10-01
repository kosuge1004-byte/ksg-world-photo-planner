# Work190 — CFA Drizzle quality hardening

Baseline: Work189
Date: 2026-08-21

## Scope
This work intentionally prioritizes image quality over speed/memory and does not change the native demosaic implementation or Linear DNG writer.

## 1. Robust-rejection saturation decision is now based on the original observation set

Before Work190, the robust path used survivor-only non-saturated coverage as the denominator while still summing saturated coverage from all input frames. This could inflate the saturated fraction after robust rejection. Example: 3 non-saturated observations + 1 saturated observation, with only 1 non-saturated observation surviving robust rejection, was evaluated as 1/(1+1)=50% instead of 1/(3+1)=25%.

Work190 keeps two distinct coverages in the robust path:
- survivor coverage: used for the reconstructed scientific signal;
- pre-rejection non-saturated coverage: used only for the saturation-fraction decision.

This prevents rejected scientific samples from distorting whether the original observation set was predominantly saturated.

## 2. Reference-frame quality weighting is consistent with normal stacking

Before Work190, CFA Drizzle always assigned the selected reference frame a contribution weight of exactly 1, while the normal Milky Way stack applies the same comprehensive star-shape quality policy to the reference frame as to other frames (with zero registration residual for the reference).

Work190 mirrors that behavior in CFA Drizzle. The reference frame still has perfect registration weight, but its star-shape quality can reduce its final contribution weight when comprehensive weighting is enabled.

## 3. Coverage summation accumulates in Float64

Coverage-store summation previously accumulated directly into Float32. Work190 accumulates in Float64 and converts to Float32 only when writing the existing tile-store format, with finite/non-negative/range checks. This reduces cumulative rounding error when many frames contribute fractional drizzle coverage.

## 4. Resource ownership hardened

If construction of the auxiliary saturation coverage stores fails after robust value/coverage combination succeeds, the combined stores are now disposed rather than leaked.

## Regression evidence in this environment

- Node tests: 498/498 PASS
- Native Release CTest: 8/8 PASS
- Native ABI exports: 10 verified
- Native ASan/UBSan CTest: 8/8 PASS

## Not verified here

This runtime still has no Flutter/Dart SDK or adb, so the following remain pending for Codex/local Android environment:
- flutter pub get
- flutter analyze
- flutter test (including the new Dart saturation regression test)
- Android arm64 APK build
- Pixel process-death/background tests
- real RAW -> Linear DNG -> Adobe Lightroom/Camera Raw validation

Do not mark these as PASS until actually run.
