# Work289 — demosaic native scratch-memory hardening

Basis: Work288 memory + CPU hardening.

## Root cause addressed
Work288 reduced adaptive demosaic from 4 native workers to 2, but each worker still allocated memoization scratch arrays sized for the **entire input tile**. Therefore two workers duplicated the largest demosaic scratch allocation even though each worker only computes half of the output rows.

## Change
`native/src/mobile_stack_demosaic.c`

- Replaced full-input `demosaic_cache_init()` with `demosaic_cache_init_for_rows()`.
- Each worker now allocates memoization storage only for its own output-row interval plus `MOBILE_STACK_DEMOSAIC_REQUIRED_INPUT_RADIUS` halo.
- X coverage remains the complete input-tile width.
- Cache lookup semantics are unchanged: any dependency outside the bounded cache is simply a cache miss and is recomputed through the existing algorithm.
- Numeric storage remains `double`; interpolation equations, CFA sampling, saturation handling and output order are unchanged.
- Work288's 2-worker CPU cap is retained.

## Expected memory effect
For an interior tile where input height is approximately output height + 2*radius, Work288 allocated roughly two full dense caches (one per worker). Work289 allocates two approximately half-height caches with only a small halo overlap. Peak native demosaic memoization memory therefore approaches one full-cache equivalent instead of two.

This specifically removes duplicated **scratch** memory. It does not yet remove the separate full-frame Dart->native CFA mirror used by `NativeMobileStackDemosaicEngine`; that remains the next larger architectural memory target.

## Quality contract
This is a cache-allocation geometry change only. It does not change:
- RAW decoding
- calibration
- demosaic formulas
- CFA phase
- float/double precision
- registration
- stacking/rejection
- DNG/TIFF/JPEG output math

## Verification performed
Host native C/C++ Release build: PASS.

CTest:
- mobile_stack_raw_abi_layout: PASS
- mobile_stack_raw_c_contract: PASS
- mobile_stack_dng_hardening: PASS
- mobile_stack_dng_cli_contract: PASS
- mobile_stack_demosaic: PASS
- mobile_stack_demosaic_cache: PASS
- mobile_stack_demosaic_hash_cache_whitebox: PASS
- mobile_stack_arw_lossless: FAIL at the same pre-existing pixel-limit assertions previously recorded in Work288; no ARW code was changed in Work289.

Flutter/Dart SDK is unavailable in this environment, so Flutter analyze/test and Android-device RSS/thermal measurements are not claimed.
