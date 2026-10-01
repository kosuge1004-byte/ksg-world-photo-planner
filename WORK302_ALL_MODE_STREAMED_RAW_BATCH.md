# Work302 — all-mode streamed RAW expansion batch

## Objective
Expand the Work299–301 file-backed RAW path beyond the standard background worker, without changing image arithmetic.

## Implemented
- Star-trail session pipeline now prepares Dark/Flat as file-backed masters and requests `preferStreamedRawCalibration`.
- Milky-Way demosaic-first session pipeline: same.
- Meteor analysis pipeline: same.
- CFA Drizzle input calibration now has a direct file-backed output path: native decode-to-file -> row-stream calibration -> calibrated CFA store, avoiding the previous full `LinearRawMosaic` handoff when streaming preconditions are met.
- `runRawMosaicCalibrationJob` accepts file-backed masters and an `onMosaicStoreReady` ownership handoff. Unsupported geometry safely falls back to the established in-memory path.
- File-backed master stores are disposed immediately after the per-frame decode/calibration/demosaic scheduler becomes idle; later RGB/CFA combine stages no longer need them.

## Preserved
- Existing in-memory fallback path.
- Calibration order and formulas from Work301.
- CFA pattern, Float32/Float64 precision contracts, registration, combine and export algorithms.
- No lower-quality demosaic or downsampling fallback was added.

## Focus stack
Focus-stack is also memory-bounded without changing its established processing semantics. It still demosaics the decoder-domain RAW directly (no Phase2 calibration is injected). When geometry is already normalized, it uses native decode-to-file, reconstructs the same `sample >= whiteLevel` saturation mask in 64-row chunks, and invokes the same native production demosaic tile plan from the file-backed CFA. RAWs needing ActiveArea/orientation normalization fall back to the prior in-memory path.

## Validation limitations
Flutter/Dart SDK availability must be checked separately. Static source/wiring validation and ZIP CRC are performed in this environment.
