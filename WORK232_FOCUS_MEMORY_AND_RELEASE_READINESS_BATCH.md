# Work232 - Focus memory and release-readiness batch

Date: 2026-08-25
Baseline: Work231

## Changes
- Removed the redundant full-resolution all-ones reference coverage plane.
  The reference frame is never geometrically resampled, so `validMask: null`
  is semantically identical to an all-ones mask in the focus-measure writer.
  At 6000x4000 this removes 24,000,000 resident bytes (~22.9 MiB).
- Added an automated Node contract preventing that allocation from returning.
- Audited the next large focus-analysis allocations. The remaining major peak is
  source luminance + aligned luminance + aligned coverage during each non-reference
  frame. It was NOT rewritten in this batch because a safe streaming replacement
  changes the alignment/measure dataflow and must be Flutter equivalence-tested.
- No numerical coefficient, threshold, interpolation method, focus score,
  winner rule, regularization rule, blend rule, color transform, or DNG exposure
  contract was changed.

## Verification boundary
Node/native/sanitizer checks are run in this environment. Flutter analyze/test,
APK build, physical Pixel memory measurement, and Adobe readback remain external
because the required SDK/device/apps are unavailable here.
