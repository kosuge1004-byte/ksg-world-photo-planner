# Work253 — Standard Milky Way RGB local-residual registration integration

## Audit finding
The project already contained a guarded low-degree local residual correction model (`local_residual_correction.dart`) and the CFA Drizzle Milky Way path used it, but the normal demosaiced RGB Milky Way stack did not. The normal path stopped at one global similarity transform. Therefore spatially varying residuals (for example mild lens distortion / optical flexure not represented by one global rotation+translation) could remain even when the global fit was accepted, contributing to spatial star broadening or double structure away from the best-fit region.

## Fix
- Added optional `LocalResidualCorrectionField` support to `TiledAffineRgbResampler`.
- The RGB inverse sampling coordinate is now global similarity source coordinate + evaluated local residual at the output/reference coordinate.
- Source read bounds are expanded by the field's clamped maximum correction magnitude, preventing valid locally-corrected samples from being omitted from the tile read.
- `AdaptiveDualAlignmentResampler` forwards the local correction only to the stellar candidate; the tripod-fixed identity foreground candidate remains identity.
- Standard `registerAndCombineDecodedFrames()` now fits the same guarded local residual field already used by the CFA Drizzle path from the accepted star matches.
- Local registration is enabled by default on the quality-first high-level path, with existing safety constraints from `fitLocalResidualCorrectionField`: low-degree polynomial, robust re-fit, maximum correction magnitude clamp, and automatic zero-field fallback when the fitted correction worsens matched-star RMS.
- The reference frame has no local correction.
- Export wrappers expose/forward the local-registration controls.

## Quality/safety properties retained
- Global similarity registration remains the base transform.
- PSF centroid refinement unchanged.
- Star matching/inlier acceptance unchanged.
- Bicubic interpolation unchanged.
- Kappa-sigma / Work252 robust small-stack rejection unchanged.
- Saturation invalid-mask handling unchanged.
- Static foreground identity candidate unchanged.
- The local field cannot exceed its configured correction magnitude (default 3 px).
- The fitter returns a zero field when too few constraints exist or the correction worsens matched-star RMS.

## Regression coverage added
`tiled_affine_rgb_resampler_test.dart` now includes a known +1 px local residual field and verifies that the RGB resampler samples the locally corrected source coordinate rather than the global-only coordinate.

## Verification status
Static source checks: PASS.
Flutter/Dart tests: NOT RUN (SDK unavailable in this environment).
Android APK build: NOT RUN.
Sony α7 III real-RAW validation: NOT VERIFIED.
