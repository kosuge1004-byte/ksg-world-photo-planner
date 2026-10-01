# Work317 Phase 3 — bounded recovery + Android exit evidence

Implemented on top of Work316.

## Added
- Durable per-failure-location retry ledger beside `status.json`.
- Maximum automatic processor restarts per identical failure signature: 2.
- Third detection at the same logical location pauses automatic recovery, preserves checkpoints, stops ProcessorService redelivery, and waits for explicit user action.
- A failure signature uses the latest operation-journal ENTER record when available; otherwise status stage/currentItem.
- Manual/initial UI processor start resets the retry budget.
- Recoverable Dart failures now write the supervisor restart marker after durable status persistence.
- ProcessorService remains alive on a recoverable result long enough for the independent supervisor to kill only `:processor`; this preserves the START_REDELIVER_INTENT recovery path.
- Android 11+ `ApplicationExitInfo` collection for `:processor`, including ANR, LOW_MEMORY, CRASH, CRASH_NATIVE and other platform reason codes.
- Exit metadata persisted to `processor_exit_diagnostics.json` (last 16 events) and latest reason mirrored into stack status.
- Progress UI displays automatic recovery attempt count and the most recently collected processor exit reason.

## Quality policy
No image-quality setting, resolution, demosaic method, stack algorithm, or output precision is reduced by the retry policy.

## Static verification in this environment
- Delimiter smoke check: PASS.
- Phase-3 contract grep checks: PASS.
- ZIP CRC/integrity: performed after packaging.
- Flutter/Dart compile: NOT VERIFIED (Flutter/Dart SDK unavailable in this environment).
- Android compile: NOT VERIFIED (Android SDK/android.jar unavailable in this environment; kotlinc alone cannot resolve Android APIs).
- Real-device behavior: NOT VERIFIED.

## Changed files
- android/app/src/main/kotlin/com/mobilestack/app/SupervisorService.kt
- android/app/src/main/kotlin/com/mobilestack/app/ProcessorService.kt
- android/app/src/main/kotlin/com/mobilestack/app/MainActivity.kt
- lib/core/background/stack_job_status.dart
- lib/core/background/stack_job_reporter.dart
- lib/features/common/standard_background_progress_screen.dart
