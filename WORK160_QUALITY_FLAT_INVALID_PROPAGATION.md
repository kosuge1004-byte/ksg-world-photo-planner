# Work160 — Quality-first flat invalid propagation

Status: WIP.

## Implemented
- If every flat observation is sensor-saturated at one pixel, master-flat
  construction no longer aborts the entire calibration set.
- That site receives a neutral placeholder value of 1.0 and is marked invalid.
- Invalid master-flat sites are excluded from CFA-color normalization means.
- During flat correction, an invalid master-flat site is passed through rather
  than divided by an unmeasured value.
- Any master-flat site at or below the existing `minimumFlatValue` threshold is
  also marked invalid instead of being silently passed through as if valid.
- Existing light-frame invalid/saturation state and master-flat invalid state
  are unioned in the output mask.
- Downstream demosaic, registration and stacking already consume this mask, so
  the unusable calibration site is excluded instead of being treated as valid
  image information.

## Why this is strong evidence
The existing flat-field code already classified values at or below
`minimumFlatValue` as unusable for division. The inconsistency was that this
fact disappeared after pass-through. Likewise, an all-saturated flat pixel has
no measured sensitivity value. Marking these sites invalid preserves that
known state without inventing a replacement sensitivity.

No threshold, interpolation strength, kappa value or cosmetic-correction
parameter was changed.

## Validation
- Node/reference suite: 396/396 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- All-flat-saturated invalid-mask regression: passed.
- Low-flat-value invalid propagation regression: passed.
- Light/master invalid-mask union regression: passed.
- Static Dart source-contract checks: passed.
- Flutter/Dart SDK unavailable: Dart tests/analyze/APK not executed.
