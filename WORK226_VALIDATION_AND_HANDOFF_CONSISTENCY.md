# Work226 — validation refresh and handoff consistency

STATUS=COMPLETE_FOR_AVAILABLE_ENVIRONMENT
DATE_JST=2026-08-25

## Purpose

Work225 fixed the real Adobe default-render failure by keeping final stack DNG
`BaselineExposure` neutral at 0 EV. Work226 does not change image-processing
math. It refreshes the locally executable validation set and removes an
obsolete handoff instruction that could have reintroduced the +13 EV Adobe
white-render regression.

## Validation executed in this environment

- Node test inventory: 112 files
- Node tests: 614/614 PASS
- Native Release CTest: 8/8 PASS
- Native host ABI exports: 10/10 PASS
- Native ASan/UBSan CTest: 8/8 PASS

Logs are stored in `work226_logs/`.

## Handoff consistency fix

`CODEX_START_HERE.txt` still contained the pre-Work225 instruction to preserve
highlight headroom through `BaselineExposure`. That wording conflicts with the
real Photoshop A/B result in Work225 and could lead a later worker to restore
positive BaselineExposure and reproduce the all-white Adobe render.

The authoritative handoff now states:

- preserve Float32 LinearRaw, scene-referred data, D65 semantics and negative
  residuals;
- preserve power-of-two storage normalization needed to fit positive samples
  into the DNG Float LinearRaw reference range;
- keep final stack DNG `BaselineExposure=0 EV`;
- do not advertise the inverse storage-normalization factor as Adobe display
  exposure.

No RAW decode, calibration, demosaic, registration, local registration, focus
scoring, focus marking, focus blending, CFA Drizzle, robust combine,
reconstruction, DNG pixel storage, color transform, or mask algorithm was
changed by Work226.

## Still external / unavailable here

Flutter and Dart SDKs are not installed in this execution environment, so the
following were not rerun here:

- `flutter pub get`
- `flutter analyze`
- `flutter test`
- Android APK build
- real Pixel execution / process-death testing

Existing Work224/225 evidence records prior successful Flutter/Android/Adobe
runs, but Work226 does not relabel an unexecuted local step as PASS.
