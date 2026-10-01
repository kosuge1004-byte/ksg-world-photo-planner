# Work323 — Storage audit fixes

Base: Work322 START_STORAGE_PREFLIGHT

## Fix 1: post-decode storage shortage follows the non-restarting storage-pause path

`_ensurePostDecodeStorageHeadroom()` previously threw `StateError` when free storage was insufficient. That bypassed the dedicated `_StorageCapacityException` handler and could route a deterministic storage shortage through the generic recoverable-failure path, which requests Supervisor recovery.

Work323 changes the post-decode guard to throw `_StorageCapacityException` with required/available byte counts. The existing outer handler persists `interruptedRecoverable` through `pauseRecoverable`, preserves checkpoints, and deliberately does not create the immediate Supervisor restart marker.

## Fix 2: do not delete the previous terminal result before a new-job capacity refusal

`startStandardStack()` previously called `discardPreviousTerminalJob()` before start storage preflight. A new job that could not fit could therefore remove the previous terminal generation even though no new processing started.

Work323 adds `StackJobRegistry.previousTerminalJobReclaimableBytes()`:
- only terminal jobs are eligible;
- queued/running/interruptedRecoverable jobs return zero;
- only paths under the managed background-stack root with an accepted generation prefix are counted;
- recursive file size is used as a conservative reclaim estimate.

Start order is now:
1. estimate safely reclaimable terminal bytes;
2. preflight against current free bytes + safely reclaimable bytes;
3. if insufficient, refuse start and leave the previous terminal job untouched;
4. if sufficient, discard the previous terminal job;
5. re-read actual free storage and run preflight again;
6. only then create/stage the new job.

The refusal message also reports reclaimable previous-result bytes when present.

## Verification

- Storage/preflight focused Node contracts: 11/11 PASS.
- Full Node regression suite: 700/700 PASS, 0 FAIL.
- Flutter/Dart/Gradle executables are not available in this environment, so Flutter compile, Android build and device behavior remain unverified.
