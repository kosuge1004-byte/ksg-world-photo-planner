# Work182 — Maximum-quality reference-frame selection

Status: WIP.

## Quality issue found
Both normal Milky Way stacking and CFA Drizzle previously selected the first
usable frame as the geometric reference.

That is a processing-order decision, not an image-quality decision. The
reference frame defines the final output coordinate system and is not
resampled like the other frames, so choosing a poorer frame can preserve a
weaker native PSF/shape as the anchor of the final stack.

## Implemented
No new heuristic was invented. Reference selection now reuses the project's
existing validated image-quality model:
- detected-star median roundness;
- detected-star count relative to the best observed count;
- registrationWeight fixed to 1 because registration has not yet occurred.

A new `intrinsicReferenceFrameQualityWeight` is a direct wrapper around the
existing `comprehensiveFrameQualityWeight`.

For both normal Milky Way and CFA Drizzle:
1. detect stars for every usable candidate;
2. apply the existing saturation-influence exclusion;
3. compute the existing intrinsic star-quality score;
4. choose the highest-scoring frame as reference;
5. tie-break equal score by larger detected-star count;
6. reuse the already-computed star lists for registration.

This avoids double star detection and removes the old "first usable frame"
quality concession.

## Preserved
- Work181 full-resolution registration.
- PSF refinement enabled by default.
- comprehensive frame weighting enabled by default.
- kappa, Drizzle pixfrac, interpolation kernel and rejection thresholds
  unchanged.
- saturation-influenced stars remain excluded from reference and target
  registration.

## Validation
- Node/reference/source-contract suite: 482/482 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here; Dart compile/analyze/Flutter tests/APK
  remain for the later Codex pass.
