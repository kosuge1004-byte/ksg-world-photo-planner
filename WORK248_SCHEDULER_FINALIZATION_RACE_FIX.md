# Work248 — Scheduler finalization race fix

## Reproduced failure
Work247 error report showed 3 inputs with `CompletedJobs: 2`, `FailedJobs: 0`, while the UI still showed `1` active job, yet downstream final-render profile validation had already started and failed with:

`Missing final-render profile for successful source frame 2.`

## Root cause
`JobScheduler._pump()` called `_run(job)` before adding the returned Future to `_active`.
Because Dart async functions execute synchronously until their first await, `_run()` could emit a `running`/progress snapshot before `_active.add(task)` executed. For the last queued job this transient snapshot could therefore contain `queuedCount == 0` and `activeCount == 0`, making `JobSchedulerSnapshot.isFinished` true while the last RAW job was actually running.

`ProcessingProgressScreen` trusted that transient `isFinished` state, set `_finishing = true`, and entered `_runStackingAndShowResult()` before the last frame committed its render profile/tile store.

## Fix
1. `lib/core/engine/job_scheduler.dart`
   - Start `_run(job)` in a microtask so the Future is registered in `_active` before `_run()` can synchronously emit any state/progress snapshot.
2. `lib/features/common/processing_progress_screen.dart`
   - Added an independent terminal-job-count gate. Downstream stacking/export starts only when `completed + failed + cancelled == input frame count` in addition to `snapshot.isFinished`.
3. `test/job_scheduler_test.dart`
   - Added a regression test that uses a synchronous initial progress report and asserts that no snapshot can report finished while the executor is still active.

## Deliberately unchanged
- `requireAlignedReferenceRenderProfile()` remains fail-closed.
- No RAW quality, demosaic, WB, color matrix, DNG metadata, registration, stacking, or export-quality behavior was weakened.
- No missing-profile fallback was added.

## Verification status in this environment
- Source-level inspection: PASS
- Regression test added: PASS (source added)
- `flutter test`: NOT RUN — Flutter/Dart executables are not installed in the current execution environment.
- Android APK build: NOT RUN — Flutter/Dart/Android build toolchain unavailable in the current execution environment.

A machine with the project Flutter/Android toolchain must run the full existing test suite plus the new scheduler regression test and then build the arm64 release APK.
