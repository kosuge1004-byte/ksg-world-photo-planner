# Work181 — Maximum-quality registration correction

Status: WIP.

## Re-audit of previously deferred quality decisions

A real quality concession was found in the normal Milky Way pipeline:
registration star detection automatically reduced the longest image dimension
to 3072 pixels. This contradicted `HighestQualityPolicy`, which explicitly
disallows automatic resolution reduction.

For stacking, sub-pixel alignment error broadens/elongates the final PSF.
STScI Drizzle/TweakReg guidance treats alignment accuracy as a primary
determinant of final scientific image quality and routinely targets sub-pixel
residuals.

## Implemented

### 1. Full-resolution normal-stack registration
- Automatic 3072-pixel downsampling removed.
- Registration luminance is now sampled at native image resolution.
- Existing strip-based RGB reads remain, so source storage is still streamed.
- PSF centroid refinement now operates on native-sampled registration data.

This deliberately spends more memory/CPU for alignment quality.

### 2. Critical saturation-filter bug fixed
The normal-stack registration contained two linked errors:
- `usablePreviewStars` accidentally enumerated itself while being initialized;
- the coordinate-conversion path used `previewStars` instead of the
  saturation-filtered `usablePreviewStars`.

The filter now correctly iterates `previewStars` and the downstream path uses
the filtered result. Saturation-influenced stars therefore cannot silently
re-enter the registration solution.

### 3. High-quality defaults made consistent
The lower-level `registerAndCombineDecodedFrames` API now defaults to:
- PSF centroid refinement = enabled;
- comprehensive frame-quality weighting = enabled.

The public `runMilkyWayPipeline` already used these high-quality defaults; this
removes the lower-level quality downgrade.

## Intentionally not changed
- kappa = 2.5;
- robust rejection thresholds;
- bicubic interpolation kernel;
- CFA Drizzle pixfrac = 0.7;
- local polynomial registration remains opt-in.

Those can alter valid image content or overfit geometry, and still require
image-level comparative evidence before changing.

## Validation
- Node/reference/source-contract suite: 74/74 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here, so Dart compile/analyze/Flutter tests and
  APK build remain pending for the later Codex pass.
