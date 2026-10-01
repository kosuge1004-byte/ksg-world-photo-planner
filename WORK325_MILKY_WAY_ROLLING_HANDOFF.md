# Work325 Milky Way Rolling Accumulator (Movement Removal OFF) — Handoff

## Status
**Design and core math verified. Pipeline integration NOT started.**
This document was produced in an environment with no Dart/Flutter SDK, no
Android SDK, and no device/emulator. Everything under "Verified in this
environment" was checked with Node.js and manual code reading only.
Everything under "Not started" requires a real Flutter toolchain
(`flutter analyze`, build, on-device/emulator testing) to complete safely —
see "Recommended next environment" at the end.

## Objective
Reduce Milky Way mode's disk usage from `12 bytes/pixel × source frame
count` (unbounded, scales with frame count) to a bounded, frame-count-
independent working set — matching what Work324 already achieved for star
trail — **but only when `automaticMovingObjectRemoval` (動体削除) is OFF**.

## Why this is safe only when movement removal is OFF
`milky_way_pipeline.dart` combines frames with `TiledKappaSigmaCombiner`.
That combiner has two distinct modes selected by `enableOutlierRejection`
(= `automaticMovingObjectRemoval`):

- **ON** (default): iterative kappa-sigma clipping. Computes mean/variance
  across *all* frames, rejects outliers, recomputes, repeats
  (`maximumIterations` times). This requires every registered frame's data
  simultaneously available for each iteration — **not** reducible to a
  rolling fold without changing the algorithm (and therefore the output).
  Do not attempt to make this path rolling; any such attempt would be a
  quality change, not a storage optimization, and violates
  `CODEX_START_HERE.txt`'s constraints.
- **OFF**: degrades to a single-pass weighted average — see
  `tiled_kappa_sigma_combiner.dart` lines ~190–356 (`enableOutlierRejection
  && iteration < maximumIterations` — loop body never runs when `false`;
  the final `finalSums`/`finalWeightSums` loop is what actually executes).
  A weighted average is associative/commutative and **is** exactly
  foldable one frame at a time with zero approximation, provided the
  fold's running totals use the same numeric precision the production
  code does internally (see next section — this is not optional).

## Work already done (this session)

### 1. Core rolling-fold combiner — `lib/core/stacking/tiled_weighted_average_combiner.dart`
- `mergeIntoRollingWeightedAverageAccumulator(...)`: folds one frame's
  already-resampled/coverage-marked tile data into running
  `(weightedSum, weightSum)` totals. Same calling convention as
  `star_trail_pipeline.dart`'s `mergeStarTrailFrameIntoRollingAccumulator`
  — caller supplies `previousWeightedSum`/`previousWeightSum` (`null` for
  the first frame), gets back the next generation, and is expected to
  discard the frame's own decoded store afterward.
- `finalizeRollingWeightedAverage(...)`: divides the final
  `(weightedSum, weightSum)` into the finished `LinearRgbTileStore`,
  narrowing FP64→FP32 exactly once.
- Takes a `SingleFrameCoveredRgbRegionReader` callback (one frame, one
  tile region → `CoveredLinearRgbTile`) rather than owning a
  `LinearRgbTileStore` — the caller is expected to implement this with the
  *existing* `resampler.sampleTile`/`dualAlignment.sampleTile` calls
  already used in `milky_way_pipeline.dart`'s current combine loop
  (~lines 1050–1130), just invoked once per frame here instead of once
  per (tile, frame) pair.

### 2. Precision fix — `lib/core/image/float64_rgb_tile.dart`, `float64_rgb_tile_store.dart`, `file_backed_float64_rgb_tile_store.dart`
**Critical finding, found before touching production code:** a first
version of the rolling accumulator used this project's usual FP32-backed
`LinearRgbTileStore` for the running totals. `TiledKappaSigmaCombiner`'s
own weighted-average path (`finalSums`/`finalWeightSums`) accumulates in
`Float64List` across all frames and narrows to FP32 only once, at the
final divide. A Node.js property check (20,000 random trials, realistic
sample/weight ranges — see
`tool/rolling_weighted_average_precision_contract.test.mjs`) showed
narrowing to FP32 after *every* fold instead disagreed with the
production result in **~77% of trials** (small, parts-per-million, but
non-zero — not acceptable under this project's quality policy).

Fix: added an FP64-backed tile/store type (`Float64RgbTile` /
`Float64RgbTileStore` / `FileBackedFloat64RgbTileStore`, mirroring
`LinearRgbTile`/`FileBackedLinearRgbTileStore` exactly but with
`Float64List`) and switched the rolling accumulator to use it. Re-ran the
same 20,000-trial check: **0 mismatches**. This is now locked in as a
permanent regression test (see below) — if anyone ever changes the
accumulator back to FP32, that test fails immediately.

### 3. Regression test — `tool/rolling_weighted_average_precision_contract.test.mjs`
Three tests, all passing (part of the full 711-test suite):
1. FP64 rolling fold == production FP64-accumulated result, 5,000 random trials.
2. Documents (as a guardrail, not an aspiration) that the rejected FP32-per-fold design diverges in >30% of trials — if this ever stops being true, the guardrail itself needs re-examination, not the code.
3. Static check that `tiled_weighted_average_combiner.dart` actually uses `Float64RgbTileStore`/`Float64List` internally and narrows to `Float32List` in exactly one place.

## Verified in this environment
- All new/modified files: balanced parens/braces/brackets (mechanical check, not a syntax guarantee).
- No instance of the exact malformed-string pattern found and fixed in `memory_admission_controller.dart` earlier this session.
- Full Node regression suite: **711/711 PASS** (708 pre-existing + 3 new).
- The precision claim above: verified numerically, not just argued.

## Not started (requires a real Flutter/Android environment)

### The actual blocker: decode and registration/combine are separate phases today
`standard_stack_background_worker.dart` currently decodes **all** source
frames via a `JobScheduler` first (populating `frameStores[index]` for
every frame, with its own checkpoint/resume machinery —
`decodeCheckpoints.publishCommittedFrame`, `committedCheckpointIndices`,
etc.), and only *after* every frame is decoded does
`milky_way_pipeline.dart`'s registration (star detection, transform
estimation) and combine (resample + accumulate) phases run, reading back
from the now-fully-populated `frameStores`.

Star trail's rolling design (Work300s–324) works because its decode loop
*is* the merge loop — one frame decoded, immediately merged, immediately
discarded, in a single pass with its own purpose-built checkpoint/resume
contract. Milky Way does not have this today. Making it rolling means:

1. Interleaving decode with registration+accumulate into one loop
   (star detection needs only the current frame + the already-decoded
   reference frame — confirmed independent of other non-reference frames
   by reading `_detectRegistrationStars`, so this part is safe to do
   per-frame).
2. Building an equivalent checkpoint/resume contract for this new loop
   (what got merged already vs. what's still pending, survives a
   `:processor` restart) — this is genuinely new infrastructure, not a
   small edit, comparable in scope to what star trail's rolling
   checkpoint store (`post_decode_pipeline_checkpoint_store.dart` and
   friends) took multiple `WORK3xx` iterations to get right.
3. Keeping the reference frame's store alive throughout (same as star
   trail already does), discarding every other frame's store right after
   its fold.
4. Only *after* (1)–(3) are working and tested: shrinking the storage
   preflight estimate in `background_stack_controller.dart` for this case
   (movement-removal-OFF Milky Way) to a bounded-by-dimensions formula
   instead of `frameBytes * sourcePaths.length`. **Do this last, never
   first** — an earlier attempt this session briefly shrank the estimate
   before the execution path was ready and was caught and reverted before
   shipping; shrinking the estimate without the execution changes backing
   it up would make the preflight check pass while the job still needs
   the old (larger) amount, i.e. exactly the "runs out of disk hours in"
   failure this check exists to prevent.

### Why this wasn't attempted here
Checkpoint/resume correctness across a real `:processor` process
restart, and `JobScheduler` concurrency interaction with the new loop
shape, cannot be verified by reading code or running Node.js — they need
an actual device/emulator and the ability to kill the process mid-job and
confirm correct resume. Astrophotography source data is generally
irreplaceable (can't be "re-shot" after the fact), so this is exactly the
kind of change where "looks right" is not sufficient confidence to ship.

## Recommended next environment
Continue this in an environment with a real Dart/Flutter SDK and, ideally,
an Android emulator or device — e.g. Claude Code, Codex CLI, or Android
Studio directly, all of which (as of Google's April 2026 Android CLI
release) can drive `flutter analyze`, builds, and emulator-based testing
directly. Concretely, next session should:

1. Run `flutter analyze` on everything already changed in this session
   (including the earlier fade-feature and completion-attempt-history
   work) — it has never been analyzer-checked, only manually/Node-verified.
2. Prototype the interleaved decode+register+accumulate loop for Milky
   Way behind the `!automaticMovingObjectRemoval` condition only.
3. Build its checkpoint/resume contract and **actually test it** by
   killing the process mid-job on a device/emulator and confirming
   correct, quality-identical resume.
4. Only then, shrink the `background_stack_controller.dart` storage
   estimate for this case.
5. Add a randomized end-to-end check (batch weighted-average result vs.
   rolling weighted-average result, real frame data) analogous to the
   "randomized comparison-light reference check" Work324 ran for star
   trail's rolling max, before considering this complete.
