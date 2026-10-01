# Work175 — Frame-weight numeric integrity

Status: WIP.

## Audit result
The existing frame weighting uses:
- registration RMS residual;
- median detected-star roundness;
- detected-star count relative to the reference frame.

There is no independent, validated background-noise/SNR weighting implementation
yet. No guessed noise coefficient or SNR formula was added.

## Confirmed issue fixed
Several half-weight/quality-scale parameters only checked `> 0`. Positive
Infinity therefore passed validation and collapsed the inverse-square falloff
toward weight 1, effectively disabling quality discrimination without an error.

## Implemented
- `residualHalfWeightRadius` must be finite and positive.
- `roundnessHalfWeight` must be finite and positive.
- `countShortfallHalfWeightFraction` must be finite and positive.
- registration weight result must remain finite and in [0,1].
- combined frame quality weight must remain finite and in [0,1].
- existing minimum-weight floor behavior is unchanged.

## Intentionally unchanged
- registration residual formula;
- roundness formula;
- star-count weighting formula;
- default half-weight points;
- minimum weight default;
- multiplication of the three existing factors;
- no new background-noise/SNR weighting.

Those require image-level or independently validated noise-estimation evidence.

## Regression preparation
Dart tests added for infinite weighting-scale rejection.

## Executed validation
- Node/reference/source-contract suite: 463/463 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here: Dart tests/analyze/APK not executed.
