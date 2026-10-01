# Work193 quality handoff

Baseline: Work192.

## Implemented
- Synchronized the Node local-residual reference model with the Dart Work191 robust MAD-clipped refit.
- Added a no-regression safety gate for local registration: a fitted/clamped local correction is accepted only if it does not increase RMS residual on the matched stars versus the global-only residual field. No empirical improvement threshold is introduced; any worsening falls back to global-only registration.
- Added independent gross-outlier regression coverage to both Node reference tests and Dart tests.

## Audited, unchanged
- Linear DNG export remains 32-bit floating point.
- Linear DNG export rejects baked exposure/white-point/LUT/tone-curve adjustments.
- Finite negative linear values are not clipped before Float32 DNG serialization.
- Native RAW decoder, calibration, demosaic, CFA accumulator, robust pixel combine, reconstruction, and Linear DNG writer were not modified in Work193.

## Verification in this environment
- Node: 502/502 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI: 10 exports verified.
- ASan/UBSan CTest: 8/8 PASS.
- Flutter/Dart SDK and adb are unavailable here, so flutter analyze/test/APK and Pixel tests remain NOT RUN.

## Codex later
Use this Work193 tree as the new baseline. Run the existing Work187/188 Codex preflight requirements, then verify the new Dart local-residual tests under Flutter before treating Work193 as fully validated on Android.
