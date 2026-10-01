# Work212 checkpoint
Baseline: Work211.

Implemented:
- Modified-Laplacian per-pixel focus measure on linear luminance.
- Horizontal and vertical second-derivative magnitudes are locally averaged.
- Float64 response/integral accumulation; Float32 stored score map.
- Negative calibrated linear values are accepted; no gamma/tone/clipping.
- Winner map stores best frame index plus best-vs-second-best confidence.
- Ambiguous/flat regions remain low confidence for later conservative blending.
- No final alignment, breathing correction, depth smoothing or blending yet.

Verification:
- Node: 536/536 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN here.
