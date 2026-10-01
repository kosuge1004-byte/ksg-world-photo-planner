# Work318 Phase 4 — Post-decode recovery checkpoints

Implemented on top of Work317.

## What changed

- Added durable post-decode stack checkpoints for both star-trail and Milky Way background processing.
- The large combined RGB result is persisted as a committed file-backed store and published only after commit.
- Milky Way survivor-count/contribution data is also persisted so Linear DNG validity semantics survive restart.
- Added two-generation `current.json` / `previous.json` checkpoint pointers. A new generation is published without deleting the last known-good generation first.
- Added restore path: if a committed post-decode result exists, registration/stack combination can be skipped and final processing/export resumes from the saved result.
- Added final export receipt. If export completed and its exact file stat still matches after process death, the worker marks the job complete without rerunning heavy processing.
- Added storage-headroom guard before creating a new post-decode checkpoint. It does not reduce quality; insufficient space fails before expensive stack work starts.
- Added the device-resource MethodChannel to `ProcessorService`, so the headless `:processor` FlutterEngine can obtain real Android free-storage/memory/thermal/battery values rather than relying on the UI Activity engine.
- Added committed reopen/retain support to the file-backed contribution store.

## Recovery boundaries now available

1. Star-trail RAW decode: existing per-frame Work315 checkpoint.
2. Post-decode stack result: new Work318 durable RGB checkpoint.
3. Milky Way contribution/validity store: new Work318 durable contribution checkpoint.
4. Final export: new Work318 export receipt.

A failure during final encoding now reuses the already-committed stack result instead of recomputing the stack. A process death after the export receipt is committed skips the whole heavy pipeline on restart.

## Important limits

- The Milky Way registration + combine implementation remains one internal pipeline call. Work318 checkpoints its committed output, not every internal registration sub-step. A process death before that output commits will rerun that pipeline section.
- Star-trail optional gap-fill remains derived from the committed comparison-light stack and may rerun after restart. The expensive comparison-light stack itself is retained.
- Flutter/Dart/Android compilation and physical-device verification could not be run in this environment because the SDK/toolchain is unavailable.

## Static verification

See `WORK318_STATIC_VERIFICATION.txt`.
