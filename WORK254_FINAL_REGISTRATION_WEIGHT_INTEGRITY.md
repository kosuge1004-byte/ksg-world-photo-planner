# Work254 — Final registration RMS / frame-weight integrity audit

## Finding
Work253 added local residual correction to the normal RGB Milky Way path, but frame weighting and diagnostics still used `estimate.rmsResidual`, which measures the global similarity fit before the local residual field is applied. Therefore the weight could understate the quality of the transform that is actually sampled, and the reported RMS could describe a different transform from the final stack path.

The same pre-local RMS weighting also existed in the CFA drizzle Milky Way path.

## Fix
- Added `localResidualCorrectedRms()` to compute RMS after the optional local field is applied to the matched-star residual vectors.
- Normal RGB Milky Way stacking now fits the local field first, computes effective post-local RMS, and uses that RMS for registration weighting and diagnostics.
- CFA drizzle Milky Way stacking now does the same.
- If local correction is disabled or falls back to a zero field, effective RMS is the global residual RMS, preserving prior behavior.
- The global registration acceptance gate is NOT loosened. `estimateSimilarityTransform()` still rejects fits above its existing maximum acceptable RMS before local refinement.

## Quality/safety properties preserved
- No change to star detector thresholds.
- No change to PSF centroid refinement.
- No change to global similarity estimation or its 1.5 px acceptance gate.
- No change to local fit degree, robust refit, clamp, or fail-safe fallback.
- No change to bicubic resampling, kappa-sigma, saturation masks, edge coverage, DNG output, WB, or color processing.

## Test added
`test/local_residual_correction_test.dart` now checks that a known polynomial residual field has a positive global RMS and a near-zero corrected RMS after the fitted local field is applied.

## Verification status
- Static source inspection: PASS
- Flutter test: NOT RUN (Flutter/Dart SDK unavailable in this environment)
- Flutter analyze: NOT RUN
- Android release APK: NOT BUILT
- Sony α7 III real-RAW verification: NOT VERIFIED
