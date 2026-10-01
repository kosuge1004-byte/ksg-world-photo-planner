# Work284 Android file-picker cache persistence fix

## Observed failure
Pixel/Android star-trail processing failed with:

`RAW処理に失敗しました: /data/user/0/com.mobilestack.app/cache/file_picker/.../DSC03726.ARW / Bad state: ファイルが存在しません。`

The failing input is under the app's `cache/file_picker` directory. Work283 persisted only the *path strings* into `work_input.json`; it did not persist the RAW file bytes themselves. A deferred/background WorkManager worker could therefore start after the picker cache file had disappeared.

## Fix
Added `lib/core/background/background_input_stager.dart`.

Before WorkManager enqueue, every source RAW and calibration RAW is copied into the job-owned private directory:

- `<job>/inputs/source/...`
- `<job>/inputs/dark/...`
- `<job>/inputs/flat/...`

The payload, registry, and subsequent worker now use those staged paths. Each copy is written through a `.tmp` file, verified by byte length, then atomically renamed.

Applied to:

1. CFA Drizzle / Milky Way
2. Standard stack / Milky Way + Star Trail
3. Focus Stack
4. Focus Marking
5. Meteor Analysis
6. Meteor Composite inherits the already-staged Meteor Analysis paths

Work282's WorkManager 10 KiB payload fix and Work283's star-trail foreground protection remain present.

## Verification performed in this environment
Node source-contract tests:

- background input staging contract: PASS
- Work274 background-processing source contract: PASS
- Work283 star-trail foreground-protection source contract: PASS

Total in this focused run: 4 tests passed, 0 failed.

Flutter/Dart SDK is not installed in this environment, so `flutter test`, Android APK build, and Pixel real-device RAW execution were not performed here. Real-device completion is therefore still a required release gate.

## Behavioral note
This fix intentionally consumes additional temporary app-private storage while a background job exists, approximately equal to the selected RAW/calibration input size. The job-directory lifecycle already provides the ownership boundary for cleanup/recovery; this storage cost is the trade-off for making the background worker independent of volatile file-picker cache paths.
