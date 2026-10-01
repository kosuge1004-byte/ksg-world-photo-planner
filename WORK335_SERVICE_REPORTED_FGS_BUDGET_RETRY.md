# Work335 — service-reported mediaProcessing budget exhaustion retry

## Confirmed defect

The previous retry logic only handled a `ForegroundServiceStartNotAllowedException`
(or equivalent text) thrown synchronously by `MainActivity.startForegroundService()`.
On Android 15+, a different but normal failure path exists:

1. `startForegroundService()` is accepted.
2. `ProcessorService.onStartCommand()` runs in `:processor`.
3. `ProcessorService.startForeground()` throws `Time limit already exhausted for foreground service type mediaProcessing`.
4. `ProcessorService` correctly persisted `interruptedRecoverable`, but sent only a generic `RESULT_LAUNCH_FAILED` message to MainActivity.
5. `MainActivity` treated that asynchronous failure as terminal and immediately returned `processor_restart_failed` instead of using its foreground retry path.

That path matches the observed UI error and explains why a durable checkpoint still
existed while the automatic foreground resume did not immediately continue.

## Fix

- `ProcessorService` now tags this specific launch failure with the structured code
  `fgs-budget-exhausted` while retaining the Android message for diagnostics.
- `MainActivity` recognizes that code (plus a message fallback for compatibility),
  clears the failed acknowledgement state, and enters the existing bounded 500 ms / window-focus retry path.
- The synchronous launch path also recognizes `Time limit already exhausted` as a
  retryable foreground-service denial.
- No RAW decode, registration, stacking, checkpoint, image-quality, or export path was changed.

## Platform boundary

This does **not** remove Android's 6-hour-per-24-hour `mediaProcessing` foreground-service
limit. Android documents that bringing the app to the foreground resets the timer. The
fix prevents the app's own launch-ack handling from converting the reset/retry window
into a terminal-looking `processor_restart_failed` error. A device reboot is not part of
the intended recovery flow.

## Verification

- `tool/work335_service_reported_fgs_budget_retry_contract.test.mjs` covers the
  previously untested asynchronous service-reported budget-exhaustion path.
- Existing Work328–334 foreground-service/recovery contract tests remain applicable.
- Real-device confirmation is still required because the actual Android 15+ FGS quota
  and reset timing cannot be simulated by these source-contract tests alone.
