# Work183 — Background stack + proof-of-life progress

Status: WIP / Android implementation prepared for later Flutter/Codex validation.

## Implemented
- CFA Drizzle highest-quality pipeline is scheduled through Flutter Workmanager
  as an Android long-running foreground worker.
- Processing is independent of the progress screen lifecycle.
- Android notification permission is declared/requested.
- Foreground-worker configuration is enabled through the documented
  Workmanager dataSync foreground-service path.
- Existing highest-quality settings are preserved:
  robust rejection, PSF refinement, comprehensive frame weighting, Linear DNG,
  no tone-map bake-in.

## Proof-of-life status
Persisted status includes:
- progress percentage;
- elapsed time;
- current stage;
- current/total item count;
- last-update timestamp;
- monotonically increasing heartbeat;
- running/completed/failed state.

Heartbeat is republished every 10 seconds even when percentage does not change.
Status writes are serialized and atomic. Notification/progress-delivery failure
is non-fatal to image processing; the persisted status file is authoritative.

## UI / notifications
- No ETA / remaining-time field.
- Progress screen polls persisted status once per second.
- Ongoing notification contains percentage, stage, item count, elapsed time,
  and heartbeat.
- Completion and failure notifications are emitted.
- Returning to the app re-reads persisted status and opens the completed DNG
  when present.

## Stage reporting
Pipeline emits concrete stages:
- RAW decode/calibration;
- star detection/reference selection;
- high-precision registration;
- CFA Drizzle;
- robust outlier rejection;
- CFA reconstruction / Linear DNG export.

## Android evidence / limitation
Android WorkManager officially supports long-running workers by promoting them
to a foreground service. Current Flutter Workmanager exposes long-running
foreground workers with dataSync/shortService; it does not currently expose
Android 15's mediaProcessing foreground-service type in its documented API.
Android 15 limits dataSync/mediaProcessing foreground-service time to 6 hours
per 24 hours.

This must still be verified on Pixel 9 Pro for:
- screen off;
- app backgrounded;
- thermal throttling;
- notification permission denied/granted;
- OS process pressure;
- actual 50-frame Alpha 7 V stack.

## Validation executed here
- Node/reference/source-contract suite: 489/489 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here, therefore flutter pub get, dart analyze,
  flutter test and APK build are not yet executed.
