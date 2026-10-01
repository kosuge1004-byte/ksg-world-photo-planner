# Work329 — Android FGS timeout automatic foreground resume

## Goal
When Android stops the isolated processor because the `mediaProcessing`
foreground-service time budget is exhausted, preserve the existing durable
checkpoint and automatically continue from it as soon as the user brings
Mobile Stack back to the foreground. No manual "resume" tap is required.

## Implementation
- Added `ForegroundTimeoutRecovery`, a single process-wide recovery authority.
- Recovery runs only for a persisted `interruptedRecoverable` status whose
  `recoveryCause` is exactly `foreground-service-timeout`.
- The coordinator reconstructs `BackgroundStackLaunch` from the durable job
  registry and calls `BackgroundStackController.restartProcessor()` so the
  existing payload/checkpoints are reused.
- Concurrent callers share one `_inFlight` Future. This prevents duplicate
  processor restarts when the app root and one or more mounted progress/home
  widgets all observe the same foreground transition.
- `MobileStackApp` now observes app lifecycle globally and invokes recovery on
  `AppLifecycleState.resumed`.
- A post-frame recovery attempt covers cold UI-process relaunch while the
  recoverable job remains on disk.
- Home, standard progress, and CFA Drizzle progress surfaces all use the same
  coordinator rather than independent restart logic.

## Non-goals / platform boundary
This does not remove Android's `mediaProcessing` foreground-service time
budget. While the app stays backgrounded after the budget is exhausted,
Android does not permit this implementation to manufacture a fresh budget.
The automatic restart happens when the user foregrounds the app, which is the
platform-supported reset point.

## Quality
No image-processing, RAW decode, demosaic, registration, rejection, stacking,
meteor/star detection, or export-quality code was changed.

## Verification
See `tool/work329_foreground_auto_resume_contract.test.mjs` and the existing
FGS/recovery contract tests. Flutter/Dart compilation must still be performed
in an environment with the Flutter SDK installed.
