# Work290 - tile-streamed demosaic memory hardening

Baseline: Work289.

## Goal
Reduce peak native CFA memory during production demosaic without changing the adaptive demosaic math, FP precision, stacking logic, output resolution, or DNG/JPEG output semantics.

## Changes

1. Native demosaic ABI bumped from v2 to v3.
2. The demosaic request now carries the CFA buffer origin/extent (`cfa_buffer_x/y/width/height`).
3. Dart no longer allocates/caches one full-resolution native Float32 CFA copy for an entire mosaic.
4. For each demosaic tile, Dart copies only the tile input rectangle into a temporary native Float32 buffer, invokes native demosaic, then immediately frees that input buffer.
5. The saturation mask remains global for semantic compatibility, but its temporary Dart packed-copy allocation was removed; it now copies directly into the cached native bit buffer.
6. Native required input radius corrected from 4 to 5. The Dart mathematical reference already declared radius 5; the native implementation's 3x3 chroma-suppression -> raw-color-difference -> green/local-structure dependency can reach radius 5. The production tile plan uses overlap 24, so this does not increase normal production tile count.
7. Added a native regression test that compares a non-zero-origin local CFA tile buffer against a full-image CFA buffer and requires bit-identical RGB output.

## Memory effect
The removed allocation was `mosaic.samples.length * 4` bytes for every demosaiced full-resolution frame. For a 33 MP mosaic that is about 132 MB; for 60 MP about 240 MB. The replacement input allocation is bounded by the demosaic input tile rectangle. With a 512px output tile and the existing 24px overlap, an interior input tile is at most about 560x560 Float32 samples (~1.2 MiB), plus the existing RGB output tile and algorithm caches.

This change does not remove the earlier Native RAW decode -> Dart full-frame Float32 copy. That is a separate isolation/lifetime problem because RAW decode currently runs in `Isolate.run`; retaining native pointers across that isolate boundary would require a larger architecture change and was intentionally not attempted here.

## Validation performed
- Clean CMake Release configure/build: PASS.
- `mobile_stack_raw_abi_layout`: PASS.
- `mobile_stack_raw_c_contract`: PASS.
- `mobile_stack_dng_hardening`: PASS.
- `mobile_stack_dng_cli_contract`: PASS.
- `mobile_stack_demosaic`: PASS.
- `mobile_stack_demosaic_cache`: PASS, including new non-zero-origin local-buffer equivalence test.
- `mobile_stack_demosaic_hash_cache_whitebox`: PASS.
- `mobile_stack_arw_lossless`: FAILS at the same pre-existing pixel-limit assertions as unmodified Work289 (lines 367/457). Work289 baseline was rebuilt and reproduced the identical failure.

Flutter/Dart SDK is not available in this environment, so `flutter analyze`, Dart unit tests, APK build, and real-device RSS/thermal measurements were not run here.
