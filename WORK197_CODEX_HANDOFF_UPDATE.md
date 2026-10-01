# Codex handoff update - Work197

Use Work197 as the latest baseline instead of Work196 and earlier ZIPs.
Read `WORK197_DRIZZLE_SOURCE_COVERAGE_SEMANTICS.md` and `HANDOFF_CHECKPOINT_WORK197.txt` before changing production code.

Preserve the Work197 source-coverage contract:
- gap-filled values may be synthesized from nearby same-channel real samples;
- a synthesized position itself has zero direct source coverage;
- do not change that zero coverage into interpolation confidence without introducing a separate field/type;
- do not switch to a new interpolation method merely to make tests pass.

The pending Codex-only sequence remains Flutter 3.44.7 dependency resolution -> analyze -> Flutter tests -> Android arm64 APK -> ABI check -> Pixel real-device/process-death tests -> real RAW Linear DNG/Adobe validation.
