# Work229 - Focus-stack Linear DNG mask memory bounding

## Goal
Reduce avoidable peak memory during final focus-stack Linear DNG export without changing image-processing math, stack pixels, coverage semantics, color conversion, or DNG transparency semantics.

## Finding
`exportFocusStackLinearDng()` previously retained `FocusStackPipelineResult.coverage` (one byte per pixel, values 0/1) and allocated a second full-resolution `Uint8List` solely to convert it to DNG transparency values 0/255. For 6000x4000 output this duplicate allocation is 24,000,000 bytes.

## Change
- `exportTileStoreToLinearDng()` now accepts optional `binaryValidityMask` (0/1) in addition to the existing `transparencyMask` (0/255).
- The two mask inputs are mutually exclusive and independently validated.
- Focus-stack DNG export passes `result.coverage` directly as `binaryValidityMask`.
- The writer converts 0/1 to 0/255 in a fixed 262,144-byte buffer while serializing the transparency IFD data.
- The sink is flushed before that conversion buffer is reused, preventing queued output from observing mutated bytes.
- Existing callers using `transparencyMask` are unchanged.

## Quality invariants
- Focus-stack RGB samples: unchanged.
- Winner selection / regularization / blending: unchanged.
- Camera color transform: unchanged.
- Float32 LinearRaw storage/headroom normalization: unchanged.
- BaselineExposure: remains 0 EV.
- DNG transparency output semantics: remains 0 for invalid and 255 for valid pixels.

## Regression protection
Added `tool/raw_samples/test/focus_stack_dng_mask_memory_contract.test.mjs` and updated the two older focus-stack DNG source contracts so they assert the new bounded-memory behavior instead of requiring the removed full-size duplicate.

## Validation in this environment
- Node: 115 files, 620/620 PASS.
- Native Release CTest: 8/8 PASS.
- Native ABI exports: 10/10 PASS.
- ASan/UBSan CTest: 8/8 PASS.
- Flutter/Dart compile/test: NOT RUN (SDK unavailable in this environment).
- Android real-device test: NOT RUN (device unavailable in this environment).
- Adobe readback of a Work229-produced DNG: NOT RUN (Adobe unavailable in this environment).
