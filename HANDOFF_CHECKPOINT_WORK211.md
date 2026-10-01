# Work211 checkpoint

Baseline: Work210.

Implemented:
- Focus-stack RAW picker is functional.
- Duplicate file paths are suppressed.
- Inputs can be reordered explicitly with up/down controls.
- Minimum input count is 2.
- Structural compatibility requires matching RAW format, dimensions, CFA pattern, ActiveArea and orientation.
- Camera model identity is not guessed because the existing metadata contract does not expose it.
- Processing remains disabled in Work211; only safe input selection/validation is implemented.

Verification:
- Node: 532/532 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN in this environment.
