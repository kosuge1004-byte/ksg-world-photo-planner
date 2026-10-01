# Work322 - Start-time storage capacity preflight

## Purpose
Prevent hours of wasted processing when the selected RAW set cannot fit in the device's currently available storage.

## Implementation
- Added `BackgroundStoragePreflightException` with Japanese user-facing capacity details.
- Added `_preflightStandardStackStorage()` in `background_stack_controller.dart`.
- The check runs after reclaiming the previous terminal job but **before** a new job id/directory is created and before `BackgroundInputStager.stageGroup()` copies RAW files.
- Uses `RawFileProbe` + native metadata-only RAW probe on the selected reference frame to obtain actual pixel dimensions without full demosaic/decode.
- Estimates:
  - durable private copies of selected source/dark/flat RAW files,
  - one full-resolution FP32 RGB store per source frame,
  - post-decode/final-export working generations,
  - Milky Way contribution reserve,
  - 512 MiB filesystem/encoder safety margin.
- Compares the estimate against `availableStorageBytes` from the platform resource snapshot.
- If insufficient, processing is not launched and the UI reports estimated required capacity, current capacity, and shortfall.
- A preflight refusal resets the session to READY rather than marking a processing failure, so the user can free storage and immediately retry.
- Existing Work321 per-frame storage guards and ENOSPC fallback remain active as second/third-line protection.

## Quality impact
None. No resolution, precision, demosaic, registration, stacking or export-quality setting is changed.

## Verification
- New Work322 Node contract tests: 4/4 PASS.
- Full Node regression suite: 697/697 PASS.
- Flutter/Dart compile and Android device execution remain unverified in this environment because the SDK/toolchain is unavailable.
