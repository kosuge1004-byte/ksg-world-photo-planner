# Work171 — Stack / CFA robust-combine numeric integrity

Status: WIP.

## Audited but intentionally unchanged
The normal weighted kappa-sigma combiner was reviewed first. Its current
weighted-mean / weighted-variance equations, survivor counting, coverage
handling and output Float32-range guard did not reveal a clear specification or
numerical bug. Therefore:
- kappa remains unchanged;
- iteration count remains unchanged;
- minimum surviving-frame policy remains unchanged;
- no MAD replacement or stronger rejection policy was introduced.

Changing those would be image-quality tuning without enough evidence.

## Confirmed issue fixed: CFA Drizzle robust combine

The robust CFA combine previously trusted per-frame `value` and `coverage`
arrays after only checking dimensions/channel counts. That allowed:
- NaN/Inf scientific values;
- NaN/Inf coverage;
- negative coverage;
- malformed channel lengths;
to reach the median/MAD or weighted-final-combine path.

The tiled wrapper also converted Float64 robust output to Float32 without an
explicit range check.

### Implemented
- dimensions and channel count must be positive;
- each channel value/coverage array length must equal width*height;
- every value must be finite;
- every coverage must be finite and non-negative;
- median/MAD/sigma must remain finite;
- weighted sum, weight sum and final combined value must remain finite;
- tiled output rejects value/coverage outside finite Float32 range before
  writing the Float32 stores.

## Why this is quality-first
A NaN, Infinity or negative coverage is not an outlier-rejection preference.
It is invalid scientific state. Allowing it into median/MAD or coverage
weighting can fabricate or corrupt image data and can later be serialized as
apparently valid pixels.

No clipping of legitimate finite negative/HDR image values was added.

## Regression preparation
Dart tests were added for:
- NaN value rejection;
- infinite coverage rejection;
- negative coverage rejection.

## Executed validation
- Node/reference/source-contract suite: 440/440 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here: Dart tests/analyze/APK not executed.
