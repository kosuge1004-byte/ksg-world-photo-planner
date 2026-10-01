# Work160 — Quality-first registration saturation exclusion

Status: WIP.

## Implemented

### Normal Milky Way stack
- The sensor-saturation influence mask is now used not only during stacking,
  but also during registration-star detection.
- When registration uses the downsampled green preview, a preview sample is
  marked invalid if any source sample contributing to that block is
  saturation-influenced.
- A detected star is rejected if the star detector / PSF-refinement radius-4
  window touches an invalid preview sample.
- No new empirical halo radius was introduced: radius 4 is the detector's
  existing centroid window.

### CFA Drizzle
- Added an exact saturation-influence mask for the green luminance proxy:
  - native green proxy pixels depend only on their own green CFA site;
  - red/blue proxy pixels depend only on their orthogonal green neighbors.
- Registration stars whose radius-4 detector window touches that exact proxy
  influence mask are rejected for both reference and target frames.
- Saturated red/blue sensor sites are not incorrectly treated as contaminating
  the green proxy when they are not sampled by the proxy calculation.

## Why this is a strong-evidence change
- The current star detector computes centroid/shape statistics in a documented
  radius-4 window.
- Gaussian PSF refinement uses the same local source data.
- A clipped/saturation-influenced profile is not a valid unclipped stellar PSF
  for sub-pixel centroid estimation.
- Existing sensor saturation information is reused; no guessed brightness
  threshold or arbitrary clipping parameter was introduced.

## Executed validation
- Node/reference suite: 385/385 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Dedicated normal-stack saturated-star exclusion tests: passed.
- Dedicated CFA green-proxy support tests: passed.
- Dedicated CFA registration wiring tests: passed.
- Static Dart source-contract checks: passed.
- Flutter/Dart SDK unavailable: Dart tests/analyze/APK not executed.
