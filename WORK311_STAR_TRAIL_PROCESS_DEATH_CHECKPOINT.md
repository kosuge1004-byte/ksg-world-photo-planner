# Work311 — Star-trail process-death checkpoint/resume

## Scope
Implements durable per-frame checkpoints for the long **星の軌跡** RAW decode/calibration/demosaic stage in Android background processing. Pixel algorithms, demosaic quality, registration/compositing, aircraft removal, gap fill, export quality, and DNG rendering are unchanged.

## Failure mode addressed
Previously `status.json` persisted progress such as `10 / 354`, but decoded RGB stores lived only in the running worker process/temp-store lifetime. If Android killed/recreated the process after an ANR or other process death, the worker had no reusable per-frame decode products and scheduled all frames again.

## Implementation
- Added `_StarTrailDecodeCheckpointStore` in `standard_stack_background_worker.dart`.
- Each completely decoded frame uses a job-local file-backed FP32 RGB store under `star_trail_decode_checkpoints_v1/` beside `status.json`.
- A frame is reusable only after the RGB store is committed/flushed and an atomic JSON manifest is published.
- Manifest validation includes checkpoint version, original frame index, source path, source byte length, source modified timestamp, decoded dimensions, and exact FP32 RGB byte length.
- Partial/stale/mismatched checkpoint files are rejected and re-decoded; they are never consumed as valid pixels.
- On worker restart, valid non-reference frames are reopened with `FileBackedLinearRgbTileStore.openCommitted()` and their scheduler jobs complete without RAW re-decode.
- The selected reference frame is deliberately re-decoded after process death so its `DngFinalRenderProfile` is rebuilt from RAW metadata for deterministic final colour/tone export. This means restart may redo **at most the reference frame plus any frame that was incomplete when the process died**.
- Progress starts from the number of restored frames and is prevented from visibly regressing below that restored count while no-op restored jobs settle in the scheduler.
- For reduced-quality modes, original full-resolution checkpoint files are retained across the downscale stage so a later process death can still restart from decoded RAW frames.
- On normal success, explicit cancel, or caught terminal failure, checkpoint files are cleaned. Abrupt process death bypasses terminal cleanup, which is the condition where recovery data must survive.

## Expected behavior example
If 10 of 354 frames were fully committed and Android kills the worker process:
- On restart, up to 9 of those 10 are directly reused when frame 0 is the reference frame.
- The reference frame is re-decoded to rebuild render metadata.
- The frame that was actively decoding at process death is redone unless it had already completed its data commit + manifest publish.
- The remaining frames continue from there instead of re-decoding all 354 frames.

## Validation performed in this environment
- Existing Node regression suite: **681/681 PASS** before adding the Work311 source-contract test.
- Added `star_trail_process_death_checkpoint_source_contract.test.mjs` to enforce checkpoint/reopen/validation/reference-frame/cleanup source contracts.
- Dart/Flutter SDK is not installed in this execution environment, so a Dart analyzer/Flutter build and Android real-device process-kill test cannot be truthfully claimed here. Those remain required release gates.

## Required device verification
1. Start a large star-trail RAW job (e.g. >100 frames).
2. Wait until at least 10 frames are fully completed.
3. Force-kill the app process/worker process (not normal Cancel).
4. Reopen the app and allow WorkManager recovery.
5. Confirm diagnostic log contains `starTrail checkpoint restored N/... decoded frames`.
6. Confirm progress does not restart from zero and decoded frames are skipped except the selected reference frame.
7. Complete export and compare output pixels/metadata against an uninterrupted run using the same inputs/settings.
