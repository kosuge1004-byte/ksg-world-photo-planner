# Work184 — Release test / handoff integrity

Date: 2026-08-20
Base: Work183 implementation contained in the supplied handoff ZIP.

## Purpose
Continue from Work183 without changing image-quality behavior. Verify the
handoff claims against the actual source tree, repair validation infrastructure
where necessary, and make the handoff state truthful.

## Findings
- Work183 background implementation is present in source:
  - Workmanager long-running foreground task registration;
  - worker-side persisted status;
  - progress %, elapsed time, stage, n/N, heartbeat;
  - ongoing/completion/failure notifications;
  - UI polling/reconnection while the progress route remains alive;
  - no ETA display.
- The old HANDOFF_CHECKPOINT.txt still said BACKGROUND_IMPLEMENTED=NO. That was
  stale and contradicted the actual source.
- Flutter/Dart SDK is not installed in this validation environment, therefore
  flutter pub get / flutter analyze / flutter test / APK build are still not
  executable here.

## Native Release build issue found
A clean Release CMake build initially failed because NDEBUG compiled assert()
out of native/tests/mobile_stack_demosaic_hash_cache_whitebox_test.c. Variables
and a static helper used only by assertions consequently became unused under
-Werror.

## Fix
The white-box test now explicitly undefines NDEBUG before including the tested
implementation/assert header. This keeps assertions active in all build
configurations and prevents the Release test binary from silently losing its
actual checks.

This is test-only. No production demosaic code, stack math, registration,
rejection, CFA Drizzle, Linear DNG logic, or quality parameter was changed.

## Validation performed
- Node host tooling CI command from .github/workflows/native-raw-abi.yml:
  51/51 passed.
- Native clean CMake Release configure/build: passed after the test-only fix.
- Native CTest Release: 8/8 passed.

## Still pending
- flutter pub get
- flutter analyze
- flutter test
- Android APK build
- Pixel 9 Pro background / screen-off / thermal / RAM validation
- process-death/restart recovery behavior validation and, if required, further
  persistence work
- real Alpha 7 V 33 MP multi-frame timing
- Adobe DNG SDK/Converter + Lightroom/Camera Raw import validation
