# Work219 checkpoint
Baseline: Work218.

Implemented:
- High-precision focus-region marking for pre-composite review.
- Three spatial support radii (1/2/4) are measured independently.
- Each scale is normalized by a robust lower-half positive-response floor.
- Per-pixel multi-scale fusion uses the median, rejecting a one-scale noise spike.
- Winner confidence and coverage are required for reliable winner markings.
- Non-winning frames can also be marked when their score is within 0.88 of the best, preserving true overlap.
- Added omission-candidate analysis from overlapping reliable markings.
- Added optional auto exclusion, but it preserves all marked coverage and at least two selected frames.
- User can always re-enable or disable frames.
- Added UI checkboxes for omission display and auto exclusion.
- Actual preview-image overlay rendering and pipeline-to-UI execution remain for the next work.

Verification:
- Node: 568/568 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10 PASS.
- ASan/UBSan: 8/8 PASS.
- Flutter analyze/test/APK: NOT RUN here.
