# Work176 — Stack coverage / contribution integrity

Status: WIP.

## Evidence-led audit
Astronomical clipped stacks need per-pixel accounting of surviving inputs because
effective coverage changes output noise. The existing tiled combiner already
normalizes each final pixel by the sum of its surviving frame weights.

## Confirmed changes
- Covered RGB tiles require strictly binary coverage: 0 invalid, 1 fully valid.
- Node reference mirrors the same coverage contract.
- Uint16 per-channel contribution counting explicitly rejects overflow.

## Audited and intentionally unchanged
- surviving weighted sum / surviving weight sum normalization;
- per-pixel clipping survivor accounting;
- kappa-sigma algorithm/defaults;
- existing frame quality weighting;
- no speculative background-noise/SNR weight.

Inverse-variance weighting is defensible only when a reliable noise estimate is
available. This project does not yet have an independently validated estimator
that safely separates background noise from stars/Milky Way structure, so no
new SNR weighting was added.

## Executed validation
- Node/reference/source-contract suite: 69/69 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here: Dart tests/analyze/APK not executed.
