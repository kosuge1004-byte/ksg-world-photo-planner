# Work316 — Native Supervisor / Automatic Processor Recovery (Phase 2/5)

## Scope
This phase adds a lightweight Android-native supervisor in its own OS process.
It does not alter image-quality math, RAW decode, demosaic, stack algorithms,
or output encoding.

## Process topology
- default process: Flutter UI / user controls
- `:supervisor`: native-only `SupervisorService` (no FlutterEngine, no image buffers)
- `:processor`: heavy `ProcessorService` + processor FlutterEngine/native RAW work

## Implemented
1. `SupervisorService` runs in `android:process=":supervisor"` as a native-only `specialUse` foreground service. It deliberately does not consume the Android 15 `dataSync` six-hour quota used by the actual processor.
2. The UI now sends start/restart requests to SupervisorService rather than owning processor liveness itself.
3. Supervisor persists the active task launch parameters atomically enough for service/process recreation and uses `START_REDELIVER_INTENT`.
4. Supervisor polls every 5 seconds without depending on Flutter/UI execution.
5. If the `:processor` PID disappears while a job is queued/running, Supervisor remains alive and waits for Android to recreate/redeliver the already-started `ProcessorService` (`START_REDELIVER_INTENT`). It does not illegally launch a new FGS from the background.
6. Manual "processor restart" is initiated by the visible UI (therefore eligible to launch the replacement FGS) while Supervisor remains alive; only the `:processor` PID is killed/recreated.
7. The pre-existing external Dart stall watchdog now marks the job `interruptedRecoverable` and writes `<status>.supervisor-restart` after its 30-minute stall threshold. Supervisor consumes that marker and kills only the stuck processor PID. Because `ProcessorService` is already a started service returning `START_REDELIVER_INTENT`, Android owns process recreation/redelivery with the same payload/status/checkpoints.
8. A 35-minute native stale-status fallback exists in Supervisor in case the Dart watchdog isolate itself is unavailable; it uses the same kill-only/system-redelivery recovery path.
9. Completed/cancelled/ordinary failed/recoverable jobs stop Supervisor unless an explicit watchdog restart marker exists. Ordinary recoverable failures are intentionally not auto-looped yet; bounded retry policy is Phase 3.

## Safety properties
- Supervisor has no Flutter engine and no image-processing buffers, minimizing the chance that processor heap/FFI failure wedges recovery logic.
- Processor restart reuses Work315's persisted payload and valid checkpoints.
- Supervisor does not treat a 15-second UI heartbeat gap as a processor crash; long synchronous RAW calls can legitimately block Dart status updates. Stall recovery remains conservative (30-minute watchdog / 35-minute native fallback) to avoid killing valid maximum-quality work.
- No automatic frame exclusion and no image-quality downgrade were introduced.

## Remaining for Phase 3
- bounded retry counters / same-operation loop prevention
- staged retry policy
- ApplicationExitInfo collection and exit-reason diagnostics

## Android platform constraints handled
- Android 12+ generally forbids launching a new foreground service while the app is backgrounded. Automatic recovery therefore does **not** call `startForegroundService()` from Supervisor; it terminates only the existing processor process and relies on the started-service redelivery contract.
- Supervisor uses `specialUse` rather than `dataSync`, so its monitoring lifetime does not consume the Android 15 six-hour `dataSync` quota. The manifest declares `FOREGROUND_SERVICE_SPECIAL_USE` and a service-level subtype description as required for this type.
