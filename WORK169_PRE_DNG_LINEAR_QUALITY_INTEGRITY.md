# Work169 — Pre-DNG linear quality integrity

Status: WIP.

## Implemented

### Linear RGB color transform
- Non-finite input samples are no longer silently converted to black.
- NaN/Inf now fail fast with `InvalidLinearColorTransformInput`.
- Finite negative and >1.0 HDR/out-of-gamut values remain unchanged and are
  not clamped.
- Float32 overflow remains explicitly rejected.

### RAW CFA white-balance harmonization
- Non-finite RAW samples are rejected before phase/RGB harmonization.
- The harmonized value is checked against finite Float32 range before storage.
- Negative finite values and >1.0 finite values remain preserved.
- The existing sensor saturation mask remains unchanged; this stage does not
  invent a new clipping threshold.

### Drizzle numerical integrity
- Negative sample weights are never allowed to subtract value/coverage.
- Infinite drop radius / half-width / half-height are skipped safely instead of
  reaching geometry code with invalid extents.
- Zero weight remains a valid no-contribution sample.
- Finite out-of-frame coordinates still naturally contribute zero overlap.
- No pixfrac, kappa, interpolation, rejection, or sharpness parameter was
  retuned.

## Why these changes are quality-first
A non-finite scientific sample is not equivalent to black. Replacing it with
zero creates plausible-looking but fabricated image data. Likewise, negative
Drizzle weights can produce mathematically invalid negative coverage. These
changes preserve the distinction between valid measured data and corrupt
numeric state without clipping legitimate linear HDR or negative values.

## Regression preparation for later Codex/Flutter testing
Dart tests were updated/added for:
- non-finite RGB transform rejection;
- non-finite RAW WB harmonization rejection;
- finite negative/HDR WB preservation;
- negative Drizzle weight rejection;
- infinite Drizzle footprint safety.

## Executed validation
- Node/reference/source-contract suite: 433/433 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here: Dart tests/analyze/APK not executed.

## Intentionally unchanged
- Tone-map/display paths that clamp/sanitize for rendered outputs.
- Kappa-sigma defaults.
- Demosaic parameters.
- Registration thresholds.
- Drizzle pixfrac.
- Linear DNG Float32 headroom policy from Work168.
