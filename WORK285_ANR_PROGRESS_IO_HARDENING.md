# Work285 — Android ANR progress/I-O hardening

## Evidence from the supplied device log
- Star-trail run started with 37 frames.
- During the first RAW frame, `rawDecode 0/37` was emitted roughly 8–12 times/second.
- RSS rose from 176 MB to the 370–427 MB range, then fell and frame 1 completed; the log does not show an OOM.
- Therefore this change targets avoidable high-frequency status/notification/log traffic without changing pixel processing.

## Changes
1. `StackJobReporter.update()` now keeps every in-memory progress value but publishes routine progress at most once per second.
2. Stage changes and processed-item count changes publish immediately.
3. `publish()` still performs the authoritative status-file write, WorkManager progress forwarding, and notification update; start/heartbeat/complete/fail behavior is preserved.
4. `DiagnosticLog.log()` writes are serialized so concurrent unawaited diagnostic calls cannot pile up simultaneous flushed appends.
5. Added `DiagnosticLog.logRateLimited()` and applied it to the hot RAW scheduler snapshot diagnostic (`rawDecode-progress`) at max 1 write/second.

## Scope
Because `StackJobReporter` is shared by the background workers, the publish throttle protects all modes using it, not only star-trail. This includes standard stack/star trail and the separate focus, focus-marking, meteor, meteor-composite and CFA-drizzle workers that call `reporter.update()`.

## Image-quality impact
None intended: no decoder, demosaic, registration, rejection, stacking, tone, WB, DNG or export pixel calculation was changed. Only progress/status/notification/diagnostic publication frequency was changed.

## Verification limits
The current execution environment does not provide Flutter/Dart executables, so a real `flutter analyze` / Android build could not be run here. Static verification was performed against the source tree and the edited Dart structure was inspected. Device confirmation should rerun the same 37-frame star-trail case and at least one other mode while watching whether the Android ANR dialog recurs.
