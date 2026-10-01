# Work198 — Adaptive demosaic dependency-radius integrity

## Goal
Protect maximum-quality CFA-Drizzle reconstruction and Linear DNG validity by making the declared adaptive-demosaic input/invalidation radius match the actual source-sample dependency graph.

## Defect found
`MobileStackAdaptiveDemosaicEngine.requiredInputRadius` was 4.

The outer color-difference suppression evaluates a 3x3 neighborhood (offset 1). A neighboring raw color-difference estimate can then evaluate a neighboring green estimate (another offset 1). That green estimate's local-structure/luminance-proxy dependency reaches 3 additional CFA sites. Therefore the worst-case dependency is 1 + 1 + 3 = 5 CFA pixels from the output site.

Using 4 could under-expand CFA-Drizzle missing/saturated-source invalidity by one pixel, allowing an RGB output whose demosaic support touched invalid/synthesized input to remain marked valid in the Linear DNG transparency mask. It also understated the overlap contract for tiled adaptive demosaic.

## Change
- `MobileStackAdaptiveDemosaicEngine.requiredInputRadius`: 4 -> 5.
- CFA-Drizzle DNG validity reference default: 4 -> 5.
- Saturation-influence reference contract updated to the same radius.
- Tests updated so an isolated invalid CFA sample expands to the exact 11x11 Chebyshev footprint (121 sites) for radius 5.

## Not changed
- RAW decoding
- calibration
- CFA Drizzle splatting/accumulation
- robust combine
- gap-fill interpolation math
- adaptive demosaic equations/weights
- registration transforms
- color transform
- Linear DNG writer

This is a validity/support-footprint correction, not an image-enhancement heuristic.

## Verification
- Node: 512/512 PASS
- Native Release CTest: 8/8 PASS
- Native ABI exports: 10 PASS
- ASan/UBSan CTest: 8/8 PASS
- Work197 -> Work198 diff: only adaptive-demosaic radius plus corresponding validity/reference tests before this document/checkpoint were added.

## Still not verified in this runtime
Flutter/Dart SDK, Android APK build, Pixel 9 Pro real-RAW execution, and Adobe Linear DNG readback remain pending because this environment has no Flutter/Dart/adb runtime.
