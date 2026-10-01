# Work189 — Background job storage lifecycle hardening

## Problems found
1. Background highest-quality Linear DNG results live under `Application Support/background_stack_jobs/cfa-drizzle-.../result.dng`, but the ordinary `ResultScreen` temporary-file cleanup only recognizes the older `mobile-stack-...` temporary-directory prefixes. Background DNGs therefore remained in private app storage after the result screen was closed.
2. `StackJobRegistry.clearIfMatches()` previously matched only the fixed WorkManager unique name (`cfa-drizzle-active`). Every generation uses that same unique name, so a delayed cleanup belonging to an older generation could clear a newer generation's registry.

## Fixes
- Registry clearing can additionally require the exact `statusPath`, which is generation-specific.
- Added `discardTerminalJob()` with strict path-safety checks. It only recursively deletes a terminal job directory when status/output both live inside the app-managed `background_stack_jobs/cfa-drizzle-*` directory.
- Queued/running jobs are never deleted by terminal cleanup.
- Closing the background result screen now deletes the result/status directory and then clears only that exact generation's registry.
- Starting a new highest-quality stack reclaims the previous completed/failed/cancelled generation first, preventing abandoned Linear DNG/partial-output accumulation.
- The result screen's generic delete hook is disabled for background results so the registry owns status/result deletion as a single lifecycle operation.

## Quality impact
None. No RAW decode, calibration, demosaic, registration, CFA Drizzle, robust combine, reconstruction, or Linear DNG algorithm/source was modified.
