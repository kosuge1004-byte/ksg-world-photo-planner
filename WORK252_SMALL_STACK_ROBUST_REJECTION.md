# Work252 — Small-stack robust rejection integrity

Status: code patch + static/math verification complete; Flutter/Dart execution unavailable in this environment.

## Confirmed defect

The production Milky-Way stack used weighted mean + population variance as the first kappa-sigma pass with kappa=2.5.

For equal-weight samples containing one arbitrarily large isolated outlier and n-1 identical inliers, the outlier's standardized residual relative to the mean/population standard deviation approaches exactly:

`sqrt(n - 1)`

Therefore:

- n=3: 1.414
- n=4: 1.732
- n=5: 2.000
- n=6: 2.236
- n=7: 2.449
- n=8: 2.646

At kappa=2.5, a 3..7 frame stack cannot reject that isolated outlier on its first ordinary mean/sigma pass, regardless of how large the outlier is. Since no rejection occurs, later iterations receive the same population and do not recover from the masking effect.

This is particularly relevant to the app because real user stacks can contain only 3 frames.

NIST notes that ordinary Z-score outlier detection can be misleading for small sample sizes and recommends robust modified-Z methods based on the median and MAD. Astropy likewise provides median/MAD-based robust scale estimators; scaled MAD uses approximately 1.4826*MAD for Gaussian-equivalent sigma.

## Implemented fix

Added an opt-in exact median/MAD seed to `TiledKappaSigmaCombiner`:

- `robustSmallStackInitialization`
- `maximumFramesForRobustInitialization` (default 7)

The low-level combiner default remains OFF for backward compatibility.

Production robust-stack paths explicitly enable it in:

- Milky Way / nightscape stack
- Meteor robust background stack (both production paths)

For 3..7 frames, before ordinary iterative weighted kappa-sigma:

1. Read the aligned band for each frame.
2. For each RGB sample, use only coverage-valid observations.
3. Compute exact median center.
4. Compute exact MAD.
5. Convert MAD to Gaussian-equivalent sigma with 1.482602218505602.
6. Apply the existing kappa value to that robust spread.
7. If MAD is zero, use a tiny relative equality tolerance so a majority-identical population can reject an isolated different value instead of disabling rejection.
8. Only enable a robust rejection rule if at least `minimumSurvivingFrames` observations remain.
9. Feed that survivor rule into the existing iterative weighted mean/variance kappa-sigma passes.
10. Final combination remains the existing weighted mean of surviving samples, with the existing exact per-channel contribution counts.

## What was deliberately not changed

- kappa remains 2.5 in production.
- maximumIterations remains unchanged.
- final frame-quality weights remain unchanged.
- bicubic resampling remains unchanged.
- coverage semantics remain unchanged.
- saturation-mask semantics remain unchanged.
- contribution validity remains unchanged.
- Linear DNG export remains unchanged.
- low-level default behavior remains backward compatible unless the robust seed is explicitly enabled.

## Memory bound

The robust seed is limited to at most 7 aligned bands. With the existing `maximumPixelsPerBand=65536`, a worst-case 7-frame RGB Float32 cache is approximately 5.5 MB plus coverage/object overhead. Arbitrarily large frame-count stacks do not use this cache and stay on the existing streaming/re-read path.

## Regression tests added

`test/tiled_kappa_sigma_combiner_test.dart`:

- 3-frame [1.0, 1.1, 10.0] rejects the isolated outlier at default kappa=2.5 when robust initialization is enabled.
- clean 3-frame [0.9, 1.0, 1.1] keeps all observations.
- zero-MAD [1, 1, 10] rejects the isolated value.
- low-level default remains backward compatible and does not silently enable the robust seed.

## Verification status

Static/source verification: PASS
Mathematical masking proof: PASS
Flutter test: NOT RUN
Flutter analyze: NOT RUN
Android release APK: NOT RUN
Sony α7 III real RAW: NOT VERIFIED

