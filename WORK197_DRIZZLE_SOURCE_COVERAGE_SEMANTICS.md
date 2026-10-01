# Work197 - Drizzle source-coverage semantics hardening

## Goal
Preserve the distinction between directly measured drizzle support and synthesized gap-fill values. Highest-quality output must not allow a locally interpolated value to manufacture new source coverage.

## Finding
`fillChannelGaps()` used the original sparse coverage plane to compute a coverage-weighted local fill, but then wrote the sum of neighboring coverage into the synthesized pixel's output `coverage`.

That overloaded one field with two different meanings:
- direct source support at this exact output location; and
- confidence/support used to synthesize an interpolated value from nearby locations.

The current highest-quality Linear DNG path already keeps the original coverage store separately, so this did not immediately corrupt the Work196 DNG transparency mask. However, the generic `DrizzleResult` returned by `fillChannelGaps()` made a synthesized pixel look source-supported to any later consumer. That is a quality-safety hazard, especially around sparse star detail and coverage boundaries.

## Change
For a position below `minimumCoverage`:
- the filled **value** is still computed by the exact same same-channel, coverage-weighted local average as before;
- the filled **coverage** now remains exactly `0` because there is no direct source support at that exact position.

Measured positions (`coverage >= minimumCoverage`) still preserve both value and coverage bit-for-bit.

The fill remains single-pass over the original source coverage. A synthesized value therefore cannot create coverage and recursively spread farther into a gap.

## What was deliberately NOT changed
- kernel radius
- square/Chebyshev neighborhood
- same-channel-only interpolation
- coverage-weighted average used to generate the fill value
- RAW decode/calibration
- registration/local registration
- CFA Drizzle splatting/accumulation
- robust combine/rejection
- demosaic kernel
- color transform
- Linear DNG writer

No unverified gradient-aware or sharper interpolation algorithm was introduced without real-RAW A/B evidence.

## Verification in this environment
- Node all tests under `tool/**`: 512/512 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI export check: 10 exports PASS.
- Native ASan/UBSan CTest: 8/8 PASS.
- New regression proves a filled x=1 sample keeps coverage=0 and cannot become a synthetic source that propagates into x=2.
- New source-contract test verifies the Dart production implementation also keeps synthesized coverage at zero.

## Still not verified here
Flutter/Dart analyze/test, Android APK, Pixel real RAW, process-death device behavior, and Adobe Linear DNG readback remain NOT RUN because this runtime has no Flutter/Dart/adb.
