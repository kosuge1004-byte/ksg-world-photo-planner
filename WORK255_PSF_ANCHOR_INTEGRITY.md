# Work255 — PSF refinement anchor integrity

Baseline: Work254

## Confirmed issue
The star detector first finds an integer local-maximum candidate, then computes an intensity-weighted centroid.  Before Work255 the optional Gaussian PSF refinement discarded the original local-maximum coordinate and reconstructed the fit anchor with `star.x.round()` / `star.y.round()`.

For an asymmetric stellar profile, neighbouring contamination, or uneven noise, the intensity centroid can move by more than half a pixel.  Rounding that displaced centroid can select the wrong central sample for the 3-point logarithmic Gaussian/parabolic refinement.  Registration centroids directly control final stacked star width, so this is a quality-relevant coordinate-integrity defect.

## Fix
- `_ShapedCentroid` now preserves the detector's original integer `peakX/peakY`.
- `detectStars(... usePsfRefinement:true)` passes those exact local-maximum coordinates to the PSF refiner.
- `refineAxisWithGaussianMarginalFit` now supports an optional `anchorPosition`.
- The original intensity centroid remains the safe fallback result if the anchored 3-point fit is invalid.
- Existing callers that do not provide an anchor preserve the old behavior.

No detection threshold, PSF window radius, similarity-transform threshold, local-registration model, interpolation, kappa-sigma, frame weighting, RAW processing, or DNG output setting was changed.

## Regression coverage added
A deliberately asymmetric 1-D profile displaces the ordinary centroid toward a contaminating wing.  The new test verifies that the explicit detector-peak anchor keeps the Gaussian refinement around the true detected local maximum rather than following `centroid.round()`.

## Validation status
Static source inspection: PASS.
Flutter/Dart execution: NOT RUN in this environment.
Android APK build: NOT RUN.
Sony α7 III real RAW A/B: NOT VERIFIED.
