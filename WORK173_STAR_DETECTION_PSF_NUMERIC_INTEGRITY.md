# Work173 — Star detection / PSF centroid numeric integrity

Status: WIP.

## Demosaic quality audit result
The adaptive demosaic star/edge/color-difference heuristics were reviewed first.
No threshold or algorithm change was made because the current saturation
influence radius already covers the full documented demosaic support and no
strong evidence justified retuning:
- star-protection range;
- directional/coherence thresholds;
- median color-difference suppression;
- edge adaptation;
- boundary mirroring.

## Confirmed quality issue fixed: registration star detection
`detectStars()` previously validated dimensions but did not reject NaN/Inf
luminance or non-finite runtime thresholds. Invalid numeric state could enter:
- background median/MAD;
- detection threshold;
- local-maximum ordering;
- intensity-weighted centroid;
- second moments / roundness;
- star flux ranking.

### Implemented
- source luminance must be finite;
- thresholdSigma finite and non-negative;
- windowRadius >= 1;
- localMaxRadius/minSeparation non-negative;
- maxRoundness/maxSharpness finite and non-negative;
- minCoveredPixels/maxStars non-negative;
- noiseFloorSigma finite and non-negative;
- backgroundSampleStride >= 1.

## Gaussian PSF centroid refinement
- source luminance must be finite;
- initial X/Y and background median must be finite;
- integer peak coordinates must lie inside the image;
- existing safe fallback behavior for non-Gaussian profiles remains unchanged.

## Why this is quality-first
Star centroids directly drive frame registration. A non-finite background
statistic or centroid does not represent a weak star; it is invalid numerical
state. Rejecting it prevents bad transforms from broadening or doubling stars
across the entire stack.

No centroid threshold, PSF model, FWHM target, registration tuning or star
selection threshold was changed.

## Regression preparation for Codex/Flutter
Dart tests added for:
- NaN/Inf luminance rejection;
- invalid star-detector runtime parameters;
- non-finite PSF refinement input;
- out-of-bounds PSF peak coordinates.

## Executed validation
- Node/reference/source-contract suite: 451/451 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here: Dart tests/analyze/APK not executed.
