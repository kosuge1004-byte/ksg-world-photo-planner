# Work320 audit fixes

Work320 is based on Work319 and addresses the concrete gaps found in the zero-based Work319 inspection.

## 1. Regression-suite reconciliation

Three source-contract tests that still encoded the pre-Work313 WorkManager architecture / pre-Work318 contribution-store variable shape were updated to assert current behavior instead of obsolete source strings.

Full Node regression run:

- test files discovered: 142
- tests: 689
- pass: 689
- fail: 0

## 2. Post-decode recovery fast path

When a valid post-decode checkpoint exists, the worker no longer reprocesses every light RAW when that data is not needed to finish export.

- Milky Way: only the selected reference RAW is decoded again to reconstruct deterministic render metadata and reference tone; the committed RGB/contribution checkpoint is used for final export.
- Star trail with gap fill OFF: same reference-only recovery path.
- Star trail with gap fill ON: full source-frame recovery is intentionally retained because the current gap-fill stage still detects stars from adjacent source frames after the combined checkpoint.
- Quality downscale is skipped on the reference-only recovery path because the restored combined checkpoint already belongs to the exact processing identity/quality configuration.

No image-quality fallback was introduced.

## 3. Android 15+ foreground-service timeout handling

ProcessorService now implements Service.onTimeout(startId, fgsType). If Android exhausts the dataSync foreground-service budget, the service:

1. atomically persists `interruptedRecoverable` in the existing status file;
2. records `recoveryCause=foreground-service-timeout`;
3. does NOT create a supervisor restart marker (immediate restart cannot restore exhausted Android quota);
4. stops the foreground service within the platform timeout grace period.

The already committed checkpoints are retained. The user can foreground the app and resume.

Important platform limit: this makes timeout handling safe/recoverable; it does not make Android's 6-hour-per-24-hour background dataSync budget disappear. Fully unattended processing beyond the OS budget cannot be guaranteed while using that FGS type.

## Verification performed

- Full Node regression: 689/689 PASS.
- New Work320 source contracts: PASS.
- ZIP integrity will be checked after packaging.
- Flutter/Dart compile: not run; SDK unavailable in this environment.
- Android Gradle/Kotlin build: not run; configured Flutter/Android SDK unavailable in this environment.
- Device ANR/OOM/FGS-timeout recovery: not run here.
