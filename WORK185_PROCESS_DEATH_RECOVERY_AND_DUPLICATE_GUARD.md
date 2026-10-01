# Work185 — Process-death recovery / duplicate-job guard

Date: 2026-08-20
Base: Work184

## Purpose
Make the Work183 long-running CFA Drizzle job discoverable after the Flutter UI
process is killed/restarted, and prevent a second highest-quality stack from
being enqueued while the first one is still queued/running. Image quality and
stack mathematics are intentionally untouched.

## Implementation
- Added `StackJobRegistry` backed by the application-support directory.
- Job status/output now live under a stable application-support `background_stack_jobs` directory rather than a newly-created system temp directory.
- Before a new CFA Drizzle task is registered, the controller reads the persisted registry/status.
- A process-local in-flight launch guard also closes the concurrent double-tap/racing-call window before the registry exists.
- If the previous job is `queued` or `running`, the controller returns that exact job instead of registering another WorkManager task.
- The registry stores the WorkManager unique name, status path, output path, source paths/frame count, and creation time.
- Home screen restores the latest recoverable job and shows state, percent, stage and n/N frame count.
- Tapping the recovered job re-opens the progress observer without creating a new processing session.
- A recovered completed job opens the existing Linear DNG result; a recovered failed job surfaces its persisted error.
- The normal progress route also handles the race where another active job is discovered during a new launch attempt.
- Added direct `path_provider` dependency for the stable application-support path.

## Duplicate-start guarantee
`BackgroundStackController.startCfaDrizzle()` checks the persisted job before
creating/registering a new worker. A persisted `queued`/`running` status wins;
there is no second `registerOneOffTask()` call in that path.

## Quality impact
None. No changes were made to RAW decoding, calibration, demosaic, registration,
CFA Drizzle, rejection, reconstruction, color transforms, Linear DNG encoding,
or any quality parameter.

## Validation performed in this environment
- Node host tooling CI command: 51/51 PASS.
- Native clean CMake Release configure/build: PASS.
- Native CTest Release: 8/8 PASS.

## Validation not possible in this environment
Flutter/Dart SDK is not installed, so the following remain unverified here:
- `flutter pub get`
- `flutter analyze`
- `flutter test`
- Android APK build
- real Android process kill / relaunch / worker reattachment
- Pixel 9 Pro screen-off / thermal / RAM behavior

These items must not be reported as passed until executed in a Flutter/Android
environment.
