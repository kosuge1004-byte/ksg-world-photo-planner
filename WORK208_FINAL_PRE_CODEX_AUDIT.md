# WORK208_FINAL_PRE_CODEX_AUDIT

## Position
Work208 is the latest source baseline. Work187-207 documents remain historical evidence, but
their old "latest baseline" lines are superseded by CODEX_START_HERE.txt and this file.

## Final code-side status before Flutter/device validation
Quality-first changes through Work207 have been integrated:
- robust reference selection and registration
- robust local registration with non-worsening RMS gate
- CFA Drizzle saturation/coverage validity hardening
- source-coverage semantics preserved across gap fill
- backend-specific demosaic support radius
- Float32 scene-referred Linear DNG 1.4 contract
- DNG highlight headroom through power-of-two scaling + BaselineExposure
- negative scene-linear values retained by writer
- D65 synthetic output color semantics synchronized
- camera ColorMatrix medoid consensus
- WB metadata common-scale invariance
- CFA-aware phase WB consensus
- pathological ColorMatrix condition-number rejection

## Work208 audit findings/fixes
1. CODEX_START_HERE.txt contained mutually contradictory baseline overrides (Work189/190/193/196/197/199/200).
   It has been rewritten to one authoritative Work208 baseline.
2. Codex preflight ran only two Node test directories. Two quality tests existed outside them:
   - tool/quality/local_registration_quality.test.mjs
   - tool/quality/reference_viability_quality.test.mjs
   Preflight now discovers every `tool/**/*.test.mjs` and logs the inventory.
3. Sanitizer execution can fail before tests when libasan is not first in the loader list.
   On Linux/GCC the preflight now conditionally preloads the actual libasan path; this changes
   only test execution environment, not product code.

## Explicitly NOT verified here
- flutter pub get / regenerated pubspec.lock
- flutter analyze
- flutter test (including new Dart tests from Work190-207)
- Android arm64 APK build
- merged Android manifest/foreground-service behavior
- Pixel 9 Pro real RAW processing
- process death / relaunch recovery on device
- real Linear DNG open in Lightroom/Camera Raw
- real-image A/B: CFA Drizzle 2x vs 1x real demosaic
- final Photoshop-only stacking A/B metrics

These must remain NOT RUN until actually executed.

## No product-image algorithm change in Work208
Work208 only repairs final handoff/preflight coverage. It does not change RAW, calibration,
registration, Drizzle, robust combine, demosaic, color math, or DNG pixel encoding.
