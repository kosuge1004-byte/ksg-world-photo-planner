# Work282 Android WorkManager 10 KiB input fix

## Confirmed failure
The Android error `Data cannot occupy more than 10240 bytes when serialized` is the AndroidX WorkManager `Data.MAX_DATA_BYTES` guard. Work280 sent `sourcePaths` and other path lists directly through `registerOneOffTask(inputData: ...)`. The size therefore grew with the number and length of selected RAW file paths.

The star-trail path uses `startStandardStack`, whose Work280 input included `sourcePaths`, `darkFramePaths`, and `flatFramePaths`, so it was directly exposed to this limit.

## Fix
- Added `lib/core/background/background_task_payload.dart`.
- Full worker input is written atomically as `<job>/work_input.json`.
- WorkManager receives only `payloadPath` and `statusPath`.
- `backgroundTaskDispatcher` resolves the JSON payload before dispatching to the existing worker.
- Applied the same transport to all six Android background jobs: CFA drizzle, standard stack (Milky Way/star trail), focus stack, focus marking, meteor analysis, meteor composite.
- Legacy already-enqueued inline input remains supported when `payloadPath` is absent.

## Regression coverage
Added `test/background_task_payload_test.dart` for a 400-path payload and legacy inline compatibility.

A source-level regression check in the repair environment confirmed all 6 `registerOneOffTask` calls now use file-backed input and none passes RAW path lists directly via WorkManager `inputData`.

## Verification limitation
The repair environment did not contain a Flutter/Dart SDK, so `flutter test`, Android Gradle build, and an APK device run could not be executed here. Those remain required before calling the Android binary release-verified.
