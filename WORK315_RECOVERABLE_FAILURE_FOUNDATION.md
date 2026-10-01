# Work315 — Recoverable failure foundation (Phase 1/5)

This phase fixes the previously confirmed gap where a caught Dart error entered
`finally` and destroyed star-trail decode checkpoints.

Implemented:

1. `StackJobState.interruptedRecoverable` and persisted
   `recoverableCheckpointItems`.
2. `StackJobReporter.failRecoverable()` keeps the failure visible without
   classifying verified checkpoints as disposable.
3. Star-trail worker now deletes decode checkpoints only on successful
   completion or explicit user cancellation. Unexpected caught failures retain
   committed checkpoint files and sidecars.
4. `disposeStores()` also respects retention. This is required because
   `FileBackedLinearRgbTileStore.dispose()` deletes its backing file; merely
   skipping `cleanupAll()` would otherwise still destroy the checkpoint.
5. The standard background progress UI shows a "保存済み地点から再開" control
   and the number of verified saved frames.
6. A process-death-safe `processor_operation_journal.json` records ENTER and
   COMPLETE events before/after calibration, RAW decode and stack/export work.
   If the processor freezes inside a risky operation, the unmatched ENTER
   remains for later diagnosis/supervision.
7. Recoverable jobs are protected from terminal-job cleanup.

Not in this phase: independent native Supervisor, automatic retry/restart policy,
ApplicationExitInfo collection, post-RAW stage checkpoints, predictive memory
budgeting/buffer-pool hardening. These are Phases 2–5.
