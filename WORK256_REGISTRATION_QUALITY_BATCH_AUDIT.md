# Work256 — Registration quality batch audit

## Scope
Work255 was audited from PSF refinement through similarity acceptance, local residual fitting, frame weighting, resampling and robust combination.

## Confirmed invariants
- Global similarity registration remains fail-closed at 1.5 px RMS.
- Production Milky Way registration requires at least 5 inliers.
- Local residual correction remains optional and falls back to the global transform.
- Work254 final-transform RMS weighting remains intact.
- Work255 PSF anchor fix remains intact.

## Change
The production wrappers had overridden `fitLocalResidualCorrectionField`'s conservative default support requirement from 4 matches per polynomial coefficient to 2. A degree-2 2-D field has six basis terms, so this allowed a fitted local warp with only 12 matched stars. This is much closer to the minimum algebraic support and increases sensitivity to noisy/mismatched stars and optimistic in-sample residuals.

Work256 restores 4 matches per coefficient in the production RGB/export paths: 24 matches are required before a local field is fitted. Sparse fields do not fail registration; they safely retain the already-accepted global similarity transform. This therefore trades optional local refinement for lower overfit risk and does not discard an otherwise valid frame.

No threshold, PSF, global transform, bicubic, kappa-sigma, RAW, WB/color, or DNG quality setting was relaxed.

## Verification status
Static source checks: PASS.
Flutter/Dart tests: NOT RUN in this environment.
Android APK: NOT BUILT.
Sony α7 III real RAW: NOT VERIFIED.
