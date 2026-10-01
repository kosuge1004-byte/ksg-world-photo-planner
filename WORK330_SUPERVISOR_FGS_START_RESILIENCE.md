# Work330 — Supervisor FGS start resilience

## Real-device evidence
Work329 displayed `PlatformException(processor_start_failed, startForegroundService() not allowed: service com.mobilestack.app/.SupervisorService, ...)` when starting the star-trail job.

Source inspection confirmed that Work329 started `SupervisorService` before `ProcessorService` inside `MainActivity.startProcessor()`, and both calls were inside one failure scope. Therefore an Android FGS-start denial affecting only the auxiliary supervisor prevented the image processor from being launched and was surfaced incorrectly as `processor_start_failed`.

## Change
- `ProcessorService` is now launched first; it remains authoritative for the actual image-processing job.
- `SupervisorService` is started only after the processor launch succeeds.
- A `ForegroundServiceStartNotAllowedException` / matching Android denial text for `SupervisorService` no longer fails the image-processing job.
- The supervisor configuration is retained and retried after 500 ms and whenever the Activity window regains focus.
- Non-FGS supervisor failures are logged but do not falsely report that an already-running processor failed to start.
- Restart path uses the same ordering.
- No RAW processing, detection, stacking, quality, or checkpoint algorithms were changed.

## Verification
`tool/work330_supervisor_fgs_start_resilience_contract.test.mjs` checks source ordering, non-fatal supervisor denial handling, deferred foreground retry, and recognition of the exact observed Android error string.

Android/Kotlin compilation is not verified in this environment because the Gradle wrapper requires a network download (`services.gradle.org`) and outbound access is unavailable.
