# Work208 checkpoint

LATEST_BASELINE=WORK208
PRODUCT_QUALITY_ALGORITHM_CHANGED_IN_WORK208=NO
CODEX_START_CONTRADICTIONS=FIXED
CODEX_NODE_TEST_DISCOVERY=ALL_TOOL_TEST_MJS
CODEX_SANITIZER_LOADER_HARDENING=YES

Local verification:
- Node all tool/**/*.test.mjs: 523/523 PASS across 86 test files.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan CTest: 8/8 PASS.
- Work208 shell helper syntax: PASS.

Pending Codex/device:
- Flutter pub get/analyze/test
- Android arm64 APK
- Pixel background/process-death
- real RAW -> DNG
- Lightroom/Camera Raw readback
- final image A/B
