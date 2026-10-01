# Work172 — Adaptive demosaic numeric integrity

Status: WIP.

## Implemented
- Validates every CFA sample inside the exact requested input tile support
  before adaptive demosaic processing.
- NaN/Inf CFA input is rejected instead of being allowed to contaminate local
  green/color-difference statistics.
- Final R/G/B is computed in double precision and checked before Float32
  storage.
- Each output channel must be finite and within finite Float32 range.
- Finite negative values and finite values above 1.0 remain preserved.
- No output [0,1] clamp was added.
- Existing saturation-mask behavior and exact required input radius of 4 CFA
  pixels remain unchanged.

## Why this is quality-first
Adaptive demosaic repeatedly reuses local CFA neighborhoods. A single non-finite
input can contaminate directional energies, medians, color-difference estimates
and neighboring RGB output. Rejecting invalid numeric state before
interpolation prevents silently fabricated/corrupted detail.

## Audited but intentionally unchanged
- adaptive demosaic algorithm;
- directional thresholds;
- star-protection thresholds;
- median suppression;
- boundary condition;
- saturation influence radius.

Those need image-level evidence before retuning.

## Regression preparation
- Dart regression added for non-finite CFA rejection.
- Existing Dart regression already covers preservation of native negative CFA
  values and >1 highlights.

## Executed validation
- Node/reference/source-contract suite: 445/445 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Flutter/Dart SDK unavailable here: Dart tests/analyze/APK not executed.
