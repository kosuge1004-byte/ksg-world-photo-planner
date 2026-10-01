# Work207 quality checkpoint

Baseline: Work206.

Implemented:
- Added an explicit infinity-norm condition-number guard to every 3x3 DNG color-matrix inversion.
- Existing determinant-relative singularity protection remains.
- Matrices with condition number > 1e6 are rejected rather than allowed to amplify tiny camera-RGB errors/noise into extreme output chroma.
- No matrix coefficients are clamped or regularized; valid matrices are unchanged bit-for-bit through the existing math.

Quality rationale:
- A nonzero determinant alone does not guarantee a numerically stable inverse.
- Rejecting pathological metadata is safer than silently creating severe chroma/noise amplification.
- Threshold is deliberately very permissive (1e6) so normal camera matrices are not altered.

Verification:
- Node: 523/523 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan CTest: 8/8 PASS with libasan preloaded.
- Flutter/Dart analyze/test, APK, Pixel real RAW, Adobe readback: NOT RUN here.
