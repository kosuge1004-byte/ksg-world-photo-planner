# Work250 Deep Stack Pipeline Audit

Base: Work249.

## Additional findings fixed

1. **Mixed decoded raster dimensions were not rejected before Milky Way registration.**
   Registration uses one pixel-coordinate system and the final output adopts the selected reference raster geometry. A full-resolution/crop mixture could therefore progress through star detection and fail later (especially in adaptive foreground alignment) or produce ambiguous geometry. Work250 now fails closed immediately after decoded-store validation and reports the exact mismatched frame and dimensions.

2. **Cancellation during registration-star image preparation could not be acted upon promptly and, once introduced, could have been swallowed as a per-frame star-detection failure.**
   Work250 threads the existing cancellation callback through native-resolution registration-star preparation, checks it between strips/rows, and explicitly rethrows `TiledStackingCancelled` instead of converting it into `MilkyWayRegistrationFailed` diagnostics.

3. **Error-stage attribution could remain stuck on foreground processing after successful adaptive dual-alignment sampling.**
   `TiledKappaSigmaCombiner` repeatedly calls the frame reader. Work250 restores the owning `stackCombination` stage after each successful foreground sample, so a later kappa-sigma/statistics error is not incorrectly reported as a foreground failure.

## Quality-preserving constraints

No changes were made to star thresholds, similarity-transform math, bicubic interpolation, frame quality weights, kappa/sigma values, iteration count, adaptive foreground thresholds, Linear DNG color/WB metadata, or RAW decode/demosaic quality.

## Verification status

Static source inspection: PASS for the three changes above.
Flutter/Dart test execution: NOT RUN (SDK unavailable in this runtime).
Android APK build: NOT RUN.
Real α7 III ARW validation: NOT VERIFIED.
