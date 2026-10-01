# Work215 checkpoint
Baseline: Work214.

Implemented:
- Connected Work214 scene correspondences and Work213 scaled-similarity transform to the existing tiled RGB resampler.
- Focus breathing scale, rotation and translation are applied together in one bicubic inverse-sampling pass.
- Aligned RGB retains explicit per-pixel coverage.
- Coverage is propagated into the Modified-Laplacian focus measure.
- Invalid/uncovered borders and derivative stencils touching invalid pixels are assigned no focus response, preventing false sharp-edge winners.
- Focus measurement continues to use the linear green-channel proxy.
- No final depth-map regularization, halo suppression, blending, RAW end-to-end execution or DNG export connection yet.

Verification:
- Node: 547/547 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN here.
