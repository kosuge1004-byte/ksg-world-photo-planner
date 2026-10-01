# Work192 Codex handoff update

Use Work192 as the latest baseline, superseding Work191.

Before any further quality changes, Codex must still complete the pending
Flutter/Android tasks from the existing Work187 Codex-first handoff:
`flutter pub get`, lockfile regeneration, `flutter analyze`, `flutter test`,
Android arm64 APK build/ABI validation, and Pixel process-death/background
recovery tests.

Work192 additionally requires verifying that both Milky Way pipelines compile
with the sequence-wide `bestObservedStarCount` contribution-weight baseline.
Do not revert this to `referenceStars.length` merely to make a test pass.

No Work192 change was made to RAW decode, calibration, native demosaic,
registration estimator, drizzle accumulation, robust combine, reconstruction,
or Linear DNG writer.
