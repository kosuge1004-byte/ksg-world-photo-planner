# Work217 checkpoint
Baseline: Work216.

Implemented:
- Conservative halo-aware focus blend weights.
- High-confidence winner pixels are hard selected.
- Low-confidence pixels may blend only with immediately adjacent focus frames.
- Secondary contribution decreases as aligned RGB disagreement grows.
- Coverage holes select the nearest covered focus frame instead of fabricating spatial pixels.
- Final output uses weighted linear RGB with Float64 temporaries and one Float32 store.
- RAW end-to-end execution and DNG export remain pending.

Verification:
- Node: 557/557 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN here.
