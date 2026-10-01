# Work160 — Quality-first calibration saturation integrity

Status: WIP.

## Implemented

### Master flat
- Per-pixel master-flat median now uses only non-saturated sensor observations.
- Saturation comes from the existing RAW WhiteLevel-derived saturation mask;
  no new threshold was introduced.
- If every flat observation is saturated at the same pixel, master-flat
  construction fails explicitly rather than inventing a correction value.
- Existing per-CFA-color normalization remains unchanged.

### Master dark
- Per-pixel master-dark median now ignores saturated dark observations.
- If every dark observation is saturated at the same pixel, that master-dark
  site is marked invalid instead of treating a clipped code value as measured
  dark current.
- Dark subtraction does not subtract an unmeasured master-dark value at such a
  site.
- The invalid calibration site is unioned into the light-frame saturation mask,
  so downstream demosaic / registration / stacking can exclude its influence.

## Why this is strong evidence
- A clipped flat sample no longer represents the pixel's linear sensitivity.
- A clipped dark sample no longer represents measured dark current above the
  clipping point.
- Siril's calibration documentation explicitly requires flats to be homogeneous
  and unsaturated and states that overexposed flats cannot accurately represent
  pixel sensitivity.
- The implementation uses the sensor's existing saturation metadata rather than
  a guessed ADU percentage.

## Executed validation
- Node/reference suite: 394/394 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Dedicated saturated-flat exclusion test: passed.
- Dedicated all-flat-saturated failure test: passed.
- Dedicated saturated-dark exclusion test: passed.
- Dedicated all-dark-saturated invalid-propagation test: passed.
- Static Dart source-contract checks: passed.
- Flutter/Dart SDK unavailable: Dart tests/analyze/APK not executed.
