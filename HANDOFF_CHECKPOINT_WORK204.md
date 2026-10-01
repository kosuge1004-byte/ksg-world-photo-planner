# Work204 quality-first checkpoint

Baseline: Work203.

Implemented:
- Hardened multi-RAW camera-color consensus selection.
- When multiple candidate camera matrices form equally large compatible groups, the representative is now the actually observed matrix with the smallest summed squared coefficient distance to its compatible group (matrix medoid), instead of whichever compatible frame happened to appear first.
- The representative matrix remains an observed RAW metadata matrix; no synthetic/averaged ColorMatrix is invented.
- Existing median RGB white-balance consensus remains unchanged.

Why this is quality-safe:
- It removes input-order dependence when tiny metadata matrix differences exist.
- It avoids choosing an edge-of-cluster matrix when a more central observed matrix exists.
- It does not broaden matrix compatibility tolerance or mix incompatible cameras/profiles.
- RAW values, registration, CFA Drizzle, robust combine, gap fill, demosaic, Linear DNG sample encoding and tone behavior are unchanged.

Verification in this environment:
- Node: 519/519 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan CTest: 8/8 PASS with libasan explicitly preloaded.
- Flutter/Dart analyze/test, APK build, Pixel real RAW and Adobe readback: NOT RUN here.

External evidence checkpoint:
- Adobe continues to publish DNG 1.7.1.0 and DNG SDK 1.7.1 Build 2611 (2026-06-09), including TIFF/ARW read fixes. Adobe documents DNG as the public raw archival format and its SDK as supporting DNG read/write.
