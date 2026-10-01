# Work245 - Real uncompressed ARW end-to-end gate

Baseline: Work244

## Supplied real file audit
`DSC05609.ARW` was tested against the Work244 production native library on host.
Observed decode result:
- status: OK
- sensor: 6048 x 4024
- active area: left 12, top 12, 6000 x 4000
- CFA: RGGB
- orientation: 8
- black levels: 512 / 512 / 512 / 512
- white level: 16383
- camera WB: 1.476562 / 1.0 / 1.0 / 2.726562
- D65 matrix: present
- sample count: 24,337,152
- sample minimum: 0
- sample maximum: 16383
- samples above white level: 0

Production metadata probe also returned status OK with the same geometry,
black/white levels, WB, orientation, CFA and D65 matrix availability.

## Work245 hardening
Added an opt-in Android/iOS integration regression gate:
`integration_test/real_uncompressed_arw_pipeline_test.dart`.
It takes `MOBILE_STACK_UNCOMPRESSED_ARW_PATH`, invokes the actual FFI production
bridge and checks geometry, sample ownership/length, finite samples, and sensor
range. The user's ARW is NOT embedded in the project ZIP.

## Remaining gate
A host native decode proves the native decoder and metadata probe can read this
file, but it does not prove the full Flutter Android path (Dart FFI -> normalize
orientation/crop -> calibration -> demosaic -> stack -> export) on the Pixel.
That requires Codex/Android Flutter tooling or a new APK/device integration run.
