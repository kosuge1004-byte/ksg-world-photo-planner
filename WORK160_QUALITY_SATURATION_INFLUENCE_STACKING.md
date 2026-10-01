# Work160 — Quality-first saturation influence propagation

Status: WIP.

## Implemented
- Sensor saturation information is preserved beyond demosaic for the normal Milky Way stack.
- The RAW saturation mask is expanded by the adaptive demosaic engine's exact required input radius (4 CFA pixels).
- Bicubic registration rejects an observation when any sample in its 4x4 interpolation footprint is saturation-influenced.
- The reference frame also supplies zero coverage at saturation-influenced pixels.
- Adaptive dual sky/foreground alignment respects both source and reference saturation influence:
  - it never falls back to an invalid identity sample;
  - it does not use an invalid reference pixel to decide between identity and stellar alignment.
- Kappa-sigma therefore receives coverage=0 for these contaminated observations instead of treating clipped values as valid signal.

## Why this is conservative
The adaptive demosaic implementation documents a complete CFA read radius of four pixels.
A saturated sensor site can therefore influence demosaiced RGB values within that radius.
The high-quality registration path then uses a 4x4 Catmull-Rom interpolation footprint.
The mask propagation follows those exact existing supports rather than inventing an arbitrary halo.

## Validation
- Node/reference suite: 380/380 passed.
- Native clean CMake build: passed.
- Native CTest: 8/8 passed.
- Added exact radius-4 dilation regression.
- Added bicubic 4x4 footprint rejection regression.
- Added production-path source-contract regression from demosaic -> executor -> Milky Way -> resampler.
- Static Dart wiring/type-contract checks: passed.
- Flutter/Dart SDK unavailable: Dart tests/analyze/APK not executed.
