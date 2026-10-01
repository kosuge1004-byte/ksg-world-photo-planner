# WORK209_FINAL_QUALITY_REACHABILITY_FALLBACK_MEMORY_AUDIT

## Scope
Final static audit after Work208. No real-device or Flutter execution is claimed.

## Findings
1. Production demosaic reachability:
   - Phase2 production factory registers NativeMobileStackDemosaicEngine.
   - DemosaicRegistry.requireProduction() rejects non-production engines.
   - ReferenceBilinearDemosaic exists only in reference/tests and is not wired into the production quality factory.
   - Therefore native-backend failure is an explicit failure, not a silent bilinear fallback.

2. Automatic quality degradation:
   - HighestQualityPolicy declares FP16 fallback = false.
   - approximate math = false.
   - automatic resolution reduction = false.
   - stack accumulation precision = Float64.
   - Milky Way registration preview scale is fixed at 1; it does not automatically downsample for memory pressure.
   - Streaming chunk/tile sizing changes working-set size, not image resolution or numerical precision.

3. Precision audit:
   - RAW/calibrated mosaics and RGB stores use Float32 as designed.
   - color transforms are computed in Float64 before storing finite Float32.
   - CFA Drizzle coverage accumulation and critical aggregate paths already use higher-precision accumulation where previously hardened.
   - DNG ColorMatrix quantization is metadata SRATIONAL encoding, not pixel-data quantization.
   - Display/tone-map 8/16-bit rounding is outside the Linear DNG highest-quality output path.

4. Failure/exclusion behavior:
   - Per-frame star detection or registration failure can exclude that bad frame.
   - If too few registered frames remain, the stack fails explicitly.
   - This is not a lower-quality algorithm fallback; it is robust frame rejection.

## Work209 changes
Only regression/source-contract tests and handoff documentation were added.
No image-processing product algorithm was changed.

## Still impossible to prove statically
- actual Android memory pressure behavior/OOM on Pixel
- native library loading in the APK
- Flutter compile/analyze/test
- real RAW output quality
- Adobe DNG interpretation
These remain Codex/device tasks.
