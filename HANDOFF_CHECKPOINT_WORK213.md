# Work213 checkpoint
Baseline: Work212.

Implemented:
- Scaled-similarity inverse sampling transform for focus-stack alignment.
- Uniform focus-breathing scale, rotation and translation are applied in one resampling transform.
- Closed-form scaled-Procrustes fit from matched scene correspondences.
- One median/MAD residual outlier rejection pass, followed by refit.
- Fit stays constrained to scaled-similarity geometry; no extra matrix degrees of freedom.
- Feature-correspondence discovery and actual frame resampling are not connected yet.

Verification:
- Node: 540/540 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN here.
