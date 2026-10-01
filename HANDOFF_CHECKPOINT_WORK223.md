# Work223 checkpoint
Baseline: Work222.

Implemented:
- Added a completed-result save action to the focus-stack UI.
- The save dialog proposes a timestamped .dng filename and filters for DNG.
- Save cancellation exits without writing.
- The selected output path is normalized to a .dng extension.
- Work222 exportFocusStackLinearDng() is called directly from the UI.
- Saving has its own busy state and blocks duplicate save / concurrent focus processing.
- The saved destination is shown after success.
- No image-processing algorithm was changed in Work223.

Verification:
- Node: 588/588 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN in this environment.
- file_picker ^8.1.7 is already declared in pubspec; saveFile support is documented for Android/iOS/desktop, but exact device behavior still requires Flutter/device verification.
