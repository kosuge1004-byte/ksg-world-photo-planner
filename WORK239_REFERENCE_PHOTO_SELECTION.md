# Work239 - Explicit reference photo selection for focus stacking

Date: 2026-08-25
Baseline: Work238

## Problem
Work238 had no reference-photo selection page. Both pre-composite focus marking
and final focus stacking implicitly treated frame 0 as the reference.

## Fix
- Added a dedicated `基準写真を選択` screen.
- Added a visible `基準写真` card to the focus-stack input screen.
- The selected RAW path is retained even if the user reorders the input list.
- Removing the selected RAW clears the reference selection.
- Clearing all RAW files also clears the reference selection.
- Analysis refuses to proceed without an explicit reference selection and opens
  the selector.
- `analyzeFocusMarking` now accepts `referenceIndex`.
- `runFocusStackPipeline` now accepts `referenceIndex`.
- Both pipelines preserve original input/frame ordering while:
  - using the selected reference luminance,
  - assigning identity transform to the selected reference,
  - aligning every other frame into the selected reference coordinates,
  - retaining score/preview/measure arrays in original input order.
- Final DNG color/WB metadata comes from the selected reference exposure.
- The review model marks the reference frame and forces it selected.
- Auto-exclusion cannot remove the reference.
- Manual review cannot deselect the reference.
- Final stacking verifies that the selected subset still contains the reference.

## Quality
No RAW decode, calibration, demosaic, feature matching, alignment model,
bicubic interpolation, focus score, winner/overlap criterion, regularization,
blend algorithm, DNG normalization, or BaselineExposure=0 EV was changed.

## Verification in this environment
- Node regression: 653/653 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10/10 PASS.
- ASan/UBSan rerun: NOT PASSABLE in the current container because ASan could
  not reserve shadow memory; this is an environment allocation failure, not a
  test assertion failure. Work238 native source was not changed.
- Flutter analyze/test/APK: NOT RUN because Flutter/Dart SDK is unavailable.
- APK included with the user's Work238 handoff is stale and does NOT contain
  Work239. A new APK must be built from this Work239 source.
