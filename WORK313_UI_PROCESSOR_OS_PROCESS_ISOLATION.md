# Work313 — UI / Processor OS Process Isolation

## Goal
Prevent heavy RAW/native processing stalls from freezing the Flutter UI process.

## Android architecture after this change

- Default app process (`com.mobilestack.app`)
  - MainActivity / UI
  - status.json polling / heartbeat supervision
  - user cancellation marker
  - isolated processor restart command
- Dedicated processor process (`com.mobilestack.app:processor`)
  - `ProcessorService` foreground service
  - its own FlutterEngine + Dart VM heap/native heap for this process
  - RAW decode / demosaic / stack / artifact removal / export
  - Work311 frame checkpoints
  - Work312 Adaptive Resource Controller

The separation is an Android OS process boundary (`android:process=":processor"`), not merely another Dart isolate or FlutterEngine in the same process.

## Key changes

1. Added `ProcessorService.kt` and declared it with `android:process=":processor"`.
2. Added alternate Dart entry point `processorMain()` in `processor_runtime.dart`.
3. Added a cold-engine `runtimeReady` handshake before the native service dispatches a heavy task.
4. Android launches no heavy stack through WorkManager's same-process `BackgroundWorker`; it starts the dedicated foreground processor service instead. Existing WorkManager path remains for non-Android platforms.
5. Cross-process progress/control stays file-backed (`status.json` and the existing cancellation marker), avoiding shared Dart locks/state between UI and processor.
6. Processor service returns `START_REDELIVER_INTENT`, allowing Android to redeliver the same task intent if the processor process is killed by the OS.
7. UI detects a running status with no update for 15 seconds and shows `処理システム応答待ち（UI正常）`.
8. UI exposes `処理システムだけ再起動して続行`. The UI process finds only the `:processor` PID, terminates that PID, then starts a new processor service using the same persisted payload/status/checkpoints.
9. The processor entry point is explicitly retained in the app AOT graph and launched by library URI.

## What this does and does not guarantee

This prevents the heavy processor from sharing the UI process main looper/Dart heap/native heap. A processor ANR/native stall can therefore be isolated from the UI process. It does not make native processing incapable of hanging, and it cannot guarantee the UI itself will never ANR due to an unrelated UI bug.

## Verification performed in this environment

PASS: AndroidManifest XML parsing.
PASS: dedicated `:processor` process declaration present.
PASS: service redelivery contract present.
PASS: alternate Dart entry point + runtime-ready handshake present.
PASS: Android controller routes heavy jobs to `RemoteProcessorBridge`.
PASS: force-restart path targets only the `:processor` process name/PID.
PASS: UI stalled-processor recovery control present.
PASS: delimiter balance checks on all changed Dart/Kotlin sources.

Not verified here: Flutter/Dart compile, Android APK build, and physical-device process/ANR recovery. The container has no usable Flutter/Android SDK; `android/local.properties` points to the original Windows SDK paths. Those must be verified on the actual build machine/device before calling this release device-certified.
