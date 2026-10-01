# Codex handoff update — Work202

Use Work202 as the latest baseline, superseding Work201 and earlier ZIPs.

Before changing image-quality algorithms, first run the existing Codex preflight and verify
Flutter dependency resolution, analyze, tests and Android arm64 APK build.

Work202 DNG-specific checks to add on a machine with Flutter/Adobe tools:
1. Generate a Float32 Linear DNG containing finite negative shadow residuals and >1 input
   highlight values.
2. Confirm DNG header has no explicit BlackLevel tag 50714 and no WhiteLevel tag 50717.
3. Confirm DNGVersion/DNGBackwardVersion are 1.4.0.0.
4. Confirm DefaultBlackRender=1 and ColorimetricReference=0.
5. Confirm BaselineExposure records Work201 power-of-two highlight placement.
6. Open the generated DNG in current Adobe Camera Raw / Lightroom and verify no load error.
7. Test whether negative shadow residuals influence shadow rendering/noise when lifted.
8. Do not call any unrun Adobe test PASS.

Do not alter RAW decode, calibration, registration, CFA Drizzle, robust combine, demosaic or
DNG color semantics merely to make an application accept the file without documenting the
root cause and evidence.
