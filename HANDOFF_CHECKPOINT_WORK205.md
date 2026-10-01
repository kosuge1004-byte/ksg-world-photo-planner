# Work205 quality checkpoint

Baseline: Work204.

Implemented:
- White-balance harmonization now normalizes the source phase gains by that frame's mean green gain before computing source->target WB ratios.
- This makes harmonization invariant to an arbitrary common scale in camera WB metadata.
- The target remains green-normalized, and per-green-phase differences are preserved.
- The change prevents color metadata normalization from unintentionally changing whole-frame brightness / stack contribution / SNR.

No changes:
- RAW decode
- calibration
- registration / local registration
- CFA Drizzle accumulation
- robust combine
- gap fill
- demosaic
- DNG pixel writer
- tone/LUT/gamma

Verification:
- Node: 520/520 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan CTest: 8/8 PASS with libasan explicitly preloaded in this runtime.
- Flutter analyze/test, Android APK, Pixel real RAW, Adobe readback: NOT RUN in this environment.
