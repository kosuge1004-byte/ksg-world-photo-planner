# Work189 Codex handoff update

This file supersedes the baseline references in the older Work187 Codex handoff.

## Latest baseline
- Latest project baseline: Work189
- Work188 background recovery/atomic replacement fixes are included.
- Work189 adds terminal background-job storage lifecycle hardening.
- Highest-quality image pipeline algorithms remain unchanged.

## Verified in ChatGPT environment after Work189
- Full Node suite: 496/496 PASS
- Native Release CTest: 8/8 PASS
- Native ABI exports: 10 verified
- Native ASan/UBSan CTest: 8/8 PASS

## Work189 changes Codex must preserve
- `clearIfMatches()` can require the exact generation-specific `statusPath`.
- `discardTerminalJob()` refuses queued/running jobs and validates that status/output are inside the managed `background_stack_jobs/cfa-drizzle-*` directory before recursive deletion.
- Closing a background result discards that terminal generation as one lifecycle unit.
- Starting a new stack reclaims only the previous terminal generation.
- Do not revert these changes when resolving Flutter/Android issues.

## Still pending Codex / real Android environment
The Work187 Codex instructions remain applicable for:
- flutter pub get / pubspec.lock regeneration
- flutter analyze
- flutter test
- Android arm64 APK build and packaged native ABI check
- Pixel 9 Pro normal-background / process-death / relaunch / duplicate-job tests
- failure/no-unbounded-retry real-device test

Use `bash tool/work187_codex_preflight.sh` when Codex is eventually used, but treat this Work189 tree—not Work187/188—as the source baseline.
