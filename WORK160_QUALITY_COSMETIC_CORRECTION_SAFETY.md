# Work160 — Quality-first cosmetic-correction safety

Status: WIP.

## Implemented
- Automatic master-dark hot-pixel detection is now OFF by default.
- Automatic master-flat cold-pixel detection is now OFF by default.
- Dark subtraction and flat-field correction remain independent and unchanged.
- Cosmetic correction remains available as an explicit opt-in when validated
  thresholds are supplied.
- No new defect threshold was invented.

## Why
The existing hot-pixel detector's own design notes state that a purely relative
threshold can fail near a zero-valued dark background and therefore requires an
independent absolute threshold. The production default previously enabled the
detector while `hotPixelAbsoluteThreshold` defaulted to zero, which made that
second safeguard ineffective.

Siril likewise keeps cosmetic correction optional and exposes adjustable
master-dark sigma thresholds, warning when too many pixels would be corrected.
For a quality-first pipeline, automatic interpolation of unverified defect
coordinates should therefore not be the default.

## Validation
- Node/reference suite: 390/390 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Dedicated default-contract test: passed.
- Flutter/Dart SDK unavailable: Dart tests/analyze/APK not executed.
