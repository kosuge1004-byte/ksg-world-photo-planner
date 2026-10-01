# Work328 — Android FGS timeout recovery correction

## Changes

1. ProcessorService is classified as `mediaProcessing` instead of `dataSync`, with `FOREGROUND_SERVICE_MEDIA_PROCESSING` permission. This matches on-device photo processing semantics on Android 15+.
2. `Service.onTimeout()` still persists `interruptedRecoverable` and stops promptly. This is required by Android and intentionally does not restart in a background loop.
3. When the user brings Mobile Stack back to the foreground, a job stopped specifically by `foreground-service-timeout` is restarted automatically from durable checkpoints. The manual resume button remains as fallback.
4. The UI label `前回終了理由` is changed to `過去のprocessor終了履歴`, and timeout recovery text explicitly separates historical `CRASH` evidence from the current timeout cause.
5. Work327's `recoverableCheckpointItems` persistence and star-trail profiling changes are retained.

## Platform limit that cannot be removed

Android 15+ imposes a 6-hour-per-24-hour background execution limit on both `dataSync` and `mediaProcessing` foreground-service types. An ordinary app cannot disable that platform quota. Work328 therefore does not claim unlimited uninterrupted background execution. Its correction is: correct FGS classification, durable checkpoint preservation, safe timeout stop, and automatic checkpoint resume when the app is foregrounded (which Android documents as resetting the quota).

## Verification in this environment

- android_fgs_timeout_recovery_contract.test.mjs: 4/4 PASS
- star_trail_profile_timeout_recovery_contract.test.mjs: 2/2 PASS
- rolling_star_trail_recovery_contract.test.mjs: 8/8 PASS
- verify_work319_completion_contract.mjs: 25/25 PASS
- Flutter/Dart SDK not present in this environment, so `dart analyze`, `flutter test`, APK build and physical-device execution are not claimed as verified.
