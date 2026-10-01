# Work216 checkpoint
Baseline: Work215.

Implemented:
- Confidence-aware ordinal focus-map regularization.
- High-confidence labels remain immutable.
- Low-confidence isolated labels change only to an observed local weighted-median label with >50% local support.
- No false image-space monotonic depth assumption is imposed.
- Ambiguous focus-order refinement considers only immediately adjacent frame indices, never jumping multiple focus planes.
- Final halo suppression, blending, RAW end-to-end execution and DNG export remain pending.

Verification:
- Node: 551/551 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN here.
