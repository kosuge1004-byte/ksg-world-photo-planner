# Work160 Quality Batch — Stacking / Robust Rejection / Registration

Status: WIP. Flutter/Dart SDK tests and APK build remain unexecuted in this environment.

## Implemented
- CFA Drizzle robust rejection: zero-MAD majority case now rejects isolated clear deviations instead of retaining every frame.
- CFA Drizzle high-level/UI robust rejection defaults to enabled; fewer than 4 contributors still bypass rejection by existing design.
- Normal Milky Way registration now enables existing Gaussian PSF centroid refinement by default.
- Existing bicubic high-level resampling and prior calibration/demosaic quality changes remain intact.

## Quality rationale
- A sample set such as [500, 500, 500, 500, 5000] has MAD=0. The previous zero-MAD safety branch retained the 5000 outlier, defeating cosmic-ray/hot-pixel rejection. The new branch retains values numerically equal to the robust center and rejects clear deviations.
- PSF centroid refinement already has its own validated/fallback implementation and is used by the CFA Drizzle quality path. Enabling it in the normal Milky Way high-level registration path reduces reliance on raw centroid estimates without changing the lower-level API.

## Executed validation
- Node reference/regression suite: 369/369 passed.
- Native clean CMake build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart tests/analyze/APK: not run (SDK unavailable).
