# Work203 quality-first checkpoint

Baseline: Work202.

Implemented:
- Synchronized the synthetic Linear DNG color model around one D65 definition.
- Replaced the older rounded XYZ(D65)->linear-sRGB matrix with a higher-precision matrix whose declared D65 white (x=0.3127, y=0.3290) maps to neutral RGB.
- Synchronized the Node Linear DNG reference encoder with production semantics:
  - AsShotWhiteXY D65 instead of stale AsShotNeutral [1,1,1]
  - ColorimetricReference = 0 (scene-referred)
  - D65 CalibrationIlluminant retained
- Corrected stale production writer documentation.

Quality pipeline changes:
- No RAW decode changes.
- No calibration changes.
- No registration/local-registration changes.
- No CFA Drizzle accumulation changes.
- No robust combine changes.
- No gap-fill changes.
- No demosaic algorithm changes.
- No tone/LUT/gamma baked into Linear DNG.
- Only the synthetic output color-coordinate precision/metadata reference contract was tightened.

Verification in this environment:
- Node: 517/517 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan CTest: 8/8 PASS after explicitly preloading libasan. The first sanitizer invocation was an environment/runtime-order failure ('ASan runtime does not come first'), not a test failure in project code.
- Flutter/Dart analyze/test, Android APK, Pixel real RAW, Adobe Lightroom/Camera Raw readback: NOT RUN because those runtimes/devices are unavailable here.

Evidence:
- Adobe currently publishes DNG 1.7.1.0 and DNG SDK 1.7.1 Build 2611 (2026-06-09).
- DNG is supported by Photoshop/Lightroom/Camera Raw.
- Production DNG remains scene-referred Float32 LinearRaw.
