# HANDOFF CHECKPOINT WORK232

LATEST_BASELINE=WORK232
FINAL_STACK_DNG_BASELINE_EXPOSURE=0_EV
DATE=2026-08-25

## Batch completed
- Preserved Work229-231 file-backed memory reductions.
- Removed the reference frame's redundant full-resolution all-valid coverage
  allocation. Reference focus measurement now uses `validMask: null`, which is
  the writer's exact all-valid path.
- 6000x4000 resident-memory reduction from this change: 24,000,000 bytes
  (~22.9 MiB).
- Added a Node regression contract preventing reintroduction.
- Audited the next large focus-analysis peak. Source luminance, aligned
  luminance, and aligned coverage remain the next material target; no speculative
  streaming rewrite was applied without Flutter equivalence execution.

## Executed verification
- Node: 628/628 PASS.
- Native Release CTest: 8/8 PASS.
- Native host ABI exports: 10/10 PASS.
- ASan/UBSan CTest: 8/8 PASS when run with the repository-required libasan
  preload. The first sanitizer invocation without preload failed only because
  ASan runtime was not first in the loader list; rerun with preload passed 8/8.
- Flutter analyze/test/APK build: NOT RUN in this environment (Flutter/Dart SDK unavailable).
- Physical Pixel tests: NOT RUN.
- Adobe readback/A-B: NOT RUN.

## Quality contract
No RAW/CFA/demosaic/registration/focus/blend/color/DNG numerical coefficient,
threshold, interpolation method, or quality fallback was changed.
