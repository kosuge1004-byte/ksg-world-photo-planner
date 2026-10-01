# Work210 checkpoint

Baseline: Work209.

Implemented:
- Added ProcessingMode.focusStack.
- Added approved '深度合成' card to the home screen after 流星.
- Added FocusStackScreen route and dedicated placeholder UI.
- RAW selection and processing start remain deliberately disabled until the quality pipeline is implemented.
- Existing three modes and high-quality Milky Way experimental entry remain unchanged.

Verification:
- Node: 529/529 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN in this environment.
