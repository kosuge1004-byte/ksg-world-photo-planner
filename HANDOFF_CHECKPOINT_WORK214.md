# Work214 checkpoint

Baseline: Work213.

Implemented:
- Added general-scene focus-feature detector based on Shi-Tomasi / minimum structure-tensor eigenvalue.
- Central-difference gradients on linear luminance; no gamma/tone/sharpening.
- Non-maximum suppression limits clustered duplicate features.
- Added ZNCC patch matcher, invariant to affine brightness scale/offset.
- Matches require minimum correlation, best-vs-second separation, and mutual-best agreement.
- Connected matched scene features to Work213 robust scaled-similarity estimator.
- Still not wired into the end-to-end RAW focus-stack execution path.

Verification:
- Node: 544/544 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN here.
