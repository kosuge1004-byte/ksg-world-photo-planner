# Work192 — Global star-count quality baseline

## Problem found
Reference-frame selection already scores each usable candidate against
`bestObservedStarCount`, the maximum detected-star count in the calibrated
set. After a reference was selected, however, both the normal Milky Way stack
and CFA Drizzle reset `referenceStarCount` to `referenceStars.length` when
computing the actual contribution weights.

That reset is internally inconsistent. If a frame wins reference selection
because its stellar shapes are cleaner even though it contains fewer detected
stars, the count-shortfall penalty that influenced selection disappears from
its final stack weight. It also makes every other frame's transparency/star-
count term relative to the selected reference rather than to the best observed
frame in the same sequence.

## Work192 change
Both pipelines now keep `bestObservedStarCount` as the star-count quality
baseline for:

- the selected reference frame's actual contribution weight; and
- every registered non-reference frame's contribution weight.

Registration RMS, roundness, minimum weight, and all existing tuning constants
are unchanged. No decode, calibration, demosaic, transform-estimation, drizzle,
robust-combine, reconstruction, or Linear DNG writer algorithm was changed.

## Quality rationale
Detected-star count is already the project's transparency/visibility proxy. A
sequence-wide best-observed baseline preserves that meaning after reference
selection and prevents the quality scale from moving simply because a lower-
count frame happened to be selected as the geometric reference.

## Verification
- Node source-contract regression requires exactly two
  `referenceStarCount: bestObservedStarCount` uses in each pipeline and rejects
  any reset to `referenceStars.length`.
- Full Node suite, Native Release CTest, native ABI export check, and Linux
  ASan/UBSan suite are rerun for the Work192 handoff.
- Flutter/Dart/APK/device tests remain pending until an environment with the
  Flutter SDK and adb is used.
