# Work227 — authoritative handoff contract automation

STATUS=COMPLETE_FOR_AVAILABLE_ENVIRONMENT
DATE_JST=2026-08-25

## Purpose

Work225 fixed the real Adobe default-render regression by keeping final stack
DNG `BaselineExposure=0 EV`. Work226 corrected the authoritative handoff text.
Work227 turns that handoff rule into an automatically executed regression
contract so a later worker cannot silently restore the obsolete positive
BaselineExposure display-gain interpretation while the production writer and
handoff drift apart.

## Change

Added:

- `tool/raw_samples/test/current_handoff_baseline_exposure_contract.test.mjs`

The contract verifies that:

1. the production Linear DNG writer keeps the final Adobe default-render
   BaselineExposure at 0 EV;
2. `CODEX_START_HERE.txt` explicitly preserves final stack DNG
   `BaselineExposure=0 EV`;
3. the handoff explicitly forbids advertising the inverse power-of-two storage
   normalization as Adobe display gain;
4. the `LATEST BASELINE` named by `CODEX_START_HERE.txt` has a matching current
   checkpoint that also records `FINAL_STACK_DNG_BASELINE_EXPOSURE=0_EV`.

`tool/work187_codex_preflight.sh` already discovers every `tool/**/*.test.mjs`
file dynamically with `find`, so this new contract is automatically connected
to the standard preflight. No separate test registration was required.

## Validation executed

- Node test inventory: 113 files
- Node tests: 616/616 PASS
- Native Release CTest: 8/8 PASS
- Native host ABI exports: 10/10 PASS
- Native ASan/UBSan CTest: 8/8 PASS

Logs are in `work227_logs/`.

## Image-quality impact

None. Work227 changes no RAW decode, calibration, demosaic, registration,
local registration, focus analysis, focus marking, focus blending, CFA
Drizzle, robust combine, reconstruction, color transform, DNG pixel payload,
or mask math.

The following remain preserved:

- Float32 LinearRaw output;
- scene-referred values;
- finite negative residuals without black clipping;
- power-of-two storage normalization for positive headroom;
- final stack DNG `BaselineExposure=0 EV`.

## Still external / unavailable in this environment

Not rerun here because the required SDK/device/application is unavailable:

- `flutter pub get`
- `flutter analyze`
- `flutter test`
- Android APK build
- Pixel 9 Pro real-device memory/process-death test
- Photoshop / Adobe Camera Raw visual readback of a newly generated Work227 DNG

Do not relabel these as PASS unless actually executed.
