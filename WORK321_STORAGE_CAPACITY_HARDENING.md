# Work321 — Storage capacity / ENOSPC hardening

## Trigger
Observed Android failure during star-trail RAW processing:
`FileSystemException: writeFrom failed ... OS Error: No space left on device, errno = 28`.

## Changes
1. Added star-trail remaining-storage admission before each subsequent RAW once dimensions are known.
   - Estimates all still-uncommitted FP32 RGB stores at 12 bytes/pixel.
   - Reserves three full-frame RGB equivalents plus 512 MiB for post-decode/output overhead.
   - Does not reduce resolution, precision, demosaic quality, or output settings.
2. Added dedicated recoverable storage pause.
   - State: `interruptedRecoverable`.
   - Stage: `空き容量不足・再開待ち`.
   - Does not write the automatic supervisor-restart marker because an immediate restart cannot create free space.
3. Added ENOSPC fallback recognition (`FileSystemException.osError.errorCode == 28`, plus wrapped-message fallback).
   - Converts the low-level `Bad state/FileSystemException/errno=28` chain into a Japanese storage message.
4. Added cleanup of orphan `mobile-stack-linear-rgb-*` system-temp directories at the beginning of a new standard stack run.
   - These directories can survive processor death because normal `dispose()` is not reached.
5. Added Node contract coverage.

## Verification in this environment
- `node --test tool/storage_capacity_recovery_contract.test.mjs`: 4/4 PASS.
- `bash tool/run_all_node_tests.sh`: 693/693 PASS.
- ZIP CRC is checked after packaging.
- Flutter/Dart compile, Android Gradle build, APK, and physical-device ENOSPC/recovery remain unverified because the required SDK/device is not available here.

## Important scope
This hardening prevents the app from blindly consuming the last bytes of device storage and gives a recoverable pause instead of an errno-28 crash. It also reclaims abandoned full-frame RGB temp directories.

It does **not** change the mathematical requirement of the current full-feature star-trail pipeline to retain decoded full-resolution source stores until global aircraft/satellite analysis, optional gap analysis, and final lighten blend are complete. Therefore a very large sequence (for example hundreds of 24 MP frames) can still require tens of GB of free storage. A true bounded-disk rolling accumulator for every feature requires a separate two-pass/refactored aircraft-and-gap-analysis pipeline; silently dropping those semantics was not done here because it could change the requested output.
