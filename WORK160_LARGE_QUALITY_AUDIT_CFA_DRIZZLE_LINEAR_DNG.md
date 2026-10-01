# Work160 — Large quality audit: CFA Drizzle / robust combine / Linear DNG

Status: WIP.

## Implemented in this larger batch

### 1. Saturated CFA samples no longer contaminate scientific drizzle values
- Sensor-saturated/invalid RAW samples are not added to the normal drizzle
  value or valid-coverage accumulator.
- Their mapped footprint is recorded only in `saturationCoverageStore`.
- This applies to both rigid rotated drops and locally corrected polygon drops.
- Reconstructed saturation fraction is now:
  saturatedCoverage / (validCoverage + saturatedCoverage).
- Therefore:
  - one clipped frame cannot bias the valid drizzle value;
  - all-saturated observations remain identifiable as invalid.

### 2. CFA Drizzle numerical inputs are hardened
- `pixfrac` and `outputScale` must be finite and positive.
- Frame weights must be finite and non-negative.
- Weight 0 remains valid as an explicit no-contribution frame, preserving the
  existing API/test contract.
- Negative and infinite weights are rejected instead of creating negative or
  silently missing coverage.

### 3. Robust CFA rejection parameters are hardened
- `minCoverage` must be finite and non-negative.
- `sigmaLow` and `sigmaHigh` must be finite and positive.
- `minFramesForRejection >= 2` remains required.
- The tiled wrapper validates before allocating output stores, and the
  whole-frame reference validates the same contract.

## Linear DNG audit
Adobe DNG 1.7.1 states that the default WhiteLevel for floating-point images is
1.0. The current 32-bit Float LinearRaw writer therefore does not require a
synthetic integer WhiteLevel tag merely to be conforming.

DNG 1.4 also defines transparency-mask IFDs for undefined pixels. The current
normal stack does not yet preserve a final per-pixel contribution/validity map
through to the DNG writer. A transparency mask was therefore NOT fabricated
from black/zero-valued pixels; that would confuse valid zero-light data with
undefined data. This remains a future structural improvement.

## Audited but intentionally unchanged
- Kappa/sigma defaults: no image-specific evidence to justify retuning.
- pixfrac default: no image-specific evidence to justify retuning.
- minimumSaturationFraction: no image-specific evidence to justify retuning.
- Linear DNG tone/exposure/gamma policy: remains non-baked.
- Float32 Linear DNG WhiteLevel omission: specification-compatible default 1.0.

## Validation
- Node/reference regression suite: 401/401 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Saturated CFA value-exclusion regression: passed.
- Saturation-fraction denominator regression: passed.
- CFA finite parameter/weight regression: passed.
- Robust rejection threshold validation regression: passed.
- Static Dart source-contract checks: passed.
- Flutter/Dart SDK unavailable: Dart tests/analyze/APK not executed.
