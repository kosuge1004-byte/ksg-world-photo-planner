# Work324 Recoverable Rolling Star Trail

## Objective
Preserve maximum-quality star-trail output and process-death recovery while removing the requirement to retain one full-resolution FP32 RGB checkpoint for every source RAW.

## Architecture
Star-trail processing now uses two bounded-storage passes.

1. **Compact analysis pass**
   - Decode one RAW at the existing quality setting.
   - Run the existing star/streak analysis.
   - Persist only compact per-frame features required by aircraft/satellite rejection and gap-fill.
   - Dispose the full RGB store immediately after the compact sidecar is committed.

2. **Exact rolling comparison-light pass**
   - Decode one RAW at a time using the existing calibrated RAW path.
   - Apply the precomputed exclusion geometry.
   - Merge it into a durable FP32 RGB rolling accumulator with a separate validity/contribution store.
   - Commit a new immutable generation first, then atomically publish the manifest cursor/stage.
   - Keep the previous known-good generation until the new generation is published.
   - Dispose the current decoded frame after the durable rolling checkpoint is committed.

This keeps comparison-light arithmetic at FP32 and does not downsample, quantize, JPEG-encode, or otherwise reduce quality beyond the user's existing quality setting.

## Feature preservation
- Aircraft/satellite removal: compact streak/star features retain the signals consumed by persistence and blinking classification.
- Gap fill: uses the compact star detections from the first pass rather than retaining every RGB frame.
- Reference foreground protection: the reference RAW is re-decoded for finalization and the existing foreground-protection routine is applied.
- Fixed tone baseline: still estimated from the full-resolution reference decode before any existing quality-scale transform.
- Linear DNG behavior remains on the existing export path.

## Recovery contract
- Compact sidecars are source-fingerprinted and versioned.
- Rolling checkpoint manifests contain both `committedItems` and `checkpointStage`.
- RGB/validity generation files are committed before manifest publication.
- Current and previous immutable generations are retained through the atomic transition.
- Crash before publication resumes from the previous cursor; crash after publication resumes from the next frame.
- App-owned staged RAW inputs remain available for re-decoding, so recovery does not depend on retaining all decoded FP32 frames.

## Storage behavior
Star-trail decoded working storage no longer scales as `12 bytes/pixel × source frame count`.
The start preflight now budgets staged input bytes plus a bounded working set (currently seven FP32-RGB-equivalent frame allocations plus 768 MiB reserve). Runtime headroom uses a conservative bounded peak estimate (`84 bytes/pixel + 768 MiB`).

The tradeoff is additional RAW decoding work: the compact-analysis pass and rolling-combine pass decode sources separately. This intentionally trades processing time for bounded storage while preserving image quality and restartability.

## Verification performed in this environment
- Full Node regression suite: **708/708 PASS**.
- Focused rolling/storage/source-contract tests: **16/16 PASS**.
- Randomized comparison-light reference check: 500 finite/negative/coverage cases matched batch max and rolling max exactly.
- Structural delimiter count check on the five modified Dart files: PASS.

## Not verified here
Flutter/Dart SDK and Android SDK/device execution are unavailable in this environment. Therefore Dart analyzer/formatter, Flutter build, Android APK build, and physical-device crash/ENOSPC/process-death recovery remain unverified and must not be inferred from the static/Node results above.
