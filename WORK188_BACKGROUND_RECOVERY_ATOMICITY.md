# Work188 — Background recovery orphan/atomicity hardening

Date: 2026-08-21
Base: Work187 Codex-first handoff

## Scope
Continue development without waiting for Flutter/Codex. No image-quality path was changed.

## Verified defect 1: persisted queued job with no Android WorkManager record
Work185/186 deliberately persisted the job registry/status before calling
`registerOneOffTask()`. This is required for discoverability after enqueue, but leaves a
small crash interval between persistence and native enqueue.

Before Work188, if the process died in that interval, the next launch could read the
persisted `queued` status and `StackJobRegistry.activeJob()` would call
`Workmanager().getWorkInfo(uniqueName)`. On Android, a null result means WorkManager has
no record for that unique name. The previous code nevertheless returned the persisted
record as active, permanently blocking all future highest-quality stacks.

Work188 behavior:
- If `getWorkInfo()` returns null on Android while persisted state is queued/running,
  persist a terminal failure explaining that the corresponding WorkManager task does
  not exist and release the active-job block.
- On non-Android platforms, null is not promoted to this Android-specific conclusion.
- Query exceptions remain uncertainty, not proof of death; the duplicate guard remains
  conservative on errors.

Evidence:
- Workmanager 0.10.7 `getWorkInfo(uniqueName)` queries the task under that unique name.
- WorkInfo documentation states Android is served by WorkManager itself and is
  authoritative.

## Verified defect 2: status/registry replacement widened the crash window
The previous atomic-write helper wrote `<path>.tmp`, explicitly deleted the existing
file, then renamed the temp file. That creates an avoidable interval where the
previous authoritative status/registry no longer exists.

Dart `File.rename()` already replaces an existing file/link at the destination. Work188
therefore:
- removes the explicit destination delete;
- writes to a per-write temp name containing PID + microsecond timestamp;
- flushes the temp data before rename;
- renames over the destination;
- deletes only a leftover temp file in `finally` if rename failed.

The unique temp path also prevents the normal reporter and WorkManager stop callback
from concurrently writing the same fixed `.tmp` file.

## Regression-test repair found by full Node run
A Work183-era source contract still required nonexistent `workmanager: ^0.10.9` even
though Work186 correctly moved the app to published stable `^0.10.7`. The full Node
suite exposed this stale test. The source contract was corrected to `^0.10.7`; no
production behavior was relaxed.

## Added source-contract tests
`tool/raw_samples/test/background_stack_recovery_hardening_source_contract.test.mjs`
checks:
1. Android null WorkInfo releases an orphan queued/running record.
2. registry replacement does not delete the current file before rename.
3. status replacement uses a per-write temp path and rename replacement.

## Validation in this environment
- Full Node DNG + RAW host suite: 492/492 PASS.
- Native clean Release CTest: 8/8 PASS.
- Native ABI exports: 10 verified.
- Native Linux ASan/UBSan CTest: 8/8 PASS.
- Work187 Codex preflight upgraded to run the full Node suite instead of the older
  51-test subset.

## Still Codex/Flutter/device dependent
- flutter pub get / lock regeneration
- flutter analyze
- flutter test
- Android arm64 APK build
- Pixel 9 Pro process-death/background tests
- Adobe Lightroom/Camera Raw real DNG import validation

These remain NOT RUN and must not be represented as PASS.
