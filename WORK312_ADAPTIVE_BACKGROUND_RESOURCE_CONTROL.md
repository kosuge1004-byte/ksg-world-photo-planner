# Work312 — Adaptive background resource monitoring/control

## Goal
Replace the fixed long-stack 2/4 second cooldown with quality-neutral adaptive
backpressure driven by real device headroom. Preserve Work311 process-death
checkpoints and every image-quality calculation.

## Confirmed pre-change gap
`readDefaultResourceSnapshot()` primarily used a MethodChannel installed by
`MainActivity.configureFlutterEngine()`. The WorkManager task runs in a headless
Flutter engine, so that Activity-owned channel is not guaranteed to exist there;
`MissingPluginException` fell back to fixed values. Therefore the background
worker could not reliably base decisions on real memory/thermal state.

## Changes
1. Android resource reads now have a headless-safe path using `/proc/meminfo`,
   `/proc/self/status`, `/proc/stat`, `/proc/self/stat`, and readable battery
   sysfs. The MainActivity MethodChannel remains as a richer foreground source.
2. ResourceSnapshot now carries total RAM, app RSS, system/process CPU load,
   battery temperature, and available-memory fractions in addition to the
   existing fields.
3. MainActivity now reports total RAM, process PSS, Android thermal status and
   battery temperature when its channel is available.
4. Added `AdaptiveResourceController` with hysteresis and four states:
   - boost: zero cooldown
   - normal: zero cooldown
   - constrained: 2 s frame-boundary backoff
   - critical: pause before the next frame, poll once/second, resume after
     recovery; bounded at 2 minutes then falls back to the legacy 4 s ceiling
5. The standard background RAW worker now uses the adaptive controller after a
   frame is fully committed/checkpointed instead of the fixed `32+ => 4 s,
   8+ => 2 s` delay.
6. Adaptive decisions are rate-limited into DiagnosticLog with free RAM, total
   RAM, app RSS, CPU and thermal/battery-temperature evidence.

## Quality invariants
No demosaic algorithm, RAW calibration arithmetic, FP precision, stack blend,
registration, output resolution, DNG/TIFF/JPEG rendering, or metadata selection
was changed. Control is only applied between completed full-frame jobs.

## Why control remains at frame boundaries
A blocking native FFI decode/demosaic call cannot be safely preempted by Dart.
Changing its math/tiling mid-frame would create correctness and recovery risk.
The controller therefore samples and gates at the durable checkpoint boundary,
which is the safe point where Work311 has already committed the finished frame.

## Verification in this environment
- New static Node contract: 4/4 PASS.
- Full Node regression suite: 686/686 PASS.
- Flutter/Dart SDK is not installed here, so `flutter test`, `flutter analyze`,
  APK build and physical-device pressure/throttle measurements were not run.
- Gradle Kotlin compilation could not start because the wrapper distribution
  is not cached and this container has no network access to services.gradle.org.

## On-device evidence to capture
Search DiagnosticLog for `adaptiveResource`. A healthy device should show
`boost`/`normal` and no fixed 4-second delay. Under memory/thermal pressure the
log should transition to `constrained`/`critical`, then automatically return to
normal/boost after headroom recovers.
