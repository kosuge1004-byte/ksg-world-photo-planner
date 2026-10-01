# Codex handoff update - Work196

Use Work196 as the latest baseline instead of Work195 and earlier ZIPs.
Before changing production code, read `WORK196_COVERAGE_VALIDITY_HARDENING.md` and `HANDOFF_CHECKPOINT_WORK196.txt`.
Preserve the strict-positive `minimumCoverage` contract and the non-finite/negative coverage rejection added in Work196.
Do not alter image-quality algorithms merely to make Flutter/Android build or tests pass.
The pending Codex-only sequence remains: Flutter 3.44.7 dependency resolution -> analyze -> Flutter tests -> Android arm64 APK -> ABI check -> Pixel real-device/process-death tests -> real RAW Linear DNG/Adobe validation.
