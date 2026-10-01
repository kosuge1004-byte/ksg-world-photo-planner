# Work242 - Output format settings

Baseline: Work240 (the discarded HTML/Web-preview Work241 is not a baseline)
Date: 2026-08-26

## Implemented
- Settings > 出力形式 is now tappable.
- The choice sheet contains only a format name and explanatory text; no rating/stage indicators.
- User-selectable formats:
  - JPEG — 速度・容量優先
  - TIFF 16bit — 高画質な汎用編集用
  - Linear DNG — 最高画質・RAW編集用
- Selected default is persisted with SharedPreferencesAsync.
- Normal RAW workflows load that default; the existing per-session selector remains available.
- Focus Stack also loads the same default and exports JPEG/TIFF/DNG accordingly.
- Android result saving now accepts jpg/jpeg.
- iOS result saving now accepts jpg/jpeg/dng as well as TIFF/BMP.
- Added a real full-resolution JPEG export path using package:image JPEG encoding.
- JPEG changes only final export representation; stack/RAW processing remains unchanged.

## DNG speed investigation
The current Linear DNG writer explicitly writes TIFF Compression=1 (none).
Therefore no additional "fast DNG" option was added. A compressed DNG might
reduce file I/O but adds compression work; without device benchmarking there is
no evidence it would complete faster than the existing uncompressed DNG.

## Dependencies added
- image ^4.9.2
- shared_preferences ^2.5.3

`flutter pub get` must be run so pubspec.lock/platform plugin files resolve normally.

## Verification in this environment
- Node: 661/661 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10/10 PASS.
- Flutter analyze/test/APK: NOT RUN; Flutter/Dart SDK unavailable here.

## Quality contract
No RAW decode, calibration, demosaic, registration, robust combine, focus
selection, focus blending, Linear DNG scene-linear processing, DNG
BaselineExposure, or image-resolution reduction was changed.
