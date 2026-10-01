# Work230 - Focus-stack final RGB file-backed result

## Purpose
Reduce the resident-memory peak and post-stack memory retention of the full-resolution focus-stack result without changing any image-processing math or Linear-DNG semantics.

## Problem found in Work229
The production focus pipeline blended into a full-resolution `Float32List` RGB result and kept it in `FocusStackPipelineResult` until the user left the screen or started another stack. At 6000x4000:

- 24,000,000 pixels
- 3 Float32 channels/pixel
- 4 bytes/channel
- persistent final RGB allocation = 288,000,000 bytes (~274.7 MiB)

When saving, Work229 then copied that full in-memory RGB image tile-by-tile into a temporary `FileBackedLinearRgbTileStore` before the Linear-DNG writer could consume it.

## Work230 change
- Added `blendRegisteredFocusStoresToStoreMemoryBounded(...)`.
- The existing winner selection, regularization, bicubic registration, coverage handling, and halo-aware blend are unchanged.
- Each completed RGB blend tile is written directly to a final `LinearRgbTileStore`.
- `FocusStackPipelineResult` now owns the committed file-backed `cameraRgbStore` instead of a full-resolution `Float32List`.
- `exportFocusStackLinearDng(...)` passes this existing store directly to `exportTileStoreToLinearDng(...)`; the extra full-image copy before save is removed.
- The existing full-resolution binary coverage plane remains unchanged.
- The result store is explicitly disposed when replaced, when the screen is destroyed, or when a completed pipeline result cannot be handed to a mounted screen.
- If the screen is destroyed during an in-flight DNG save, cleanup is deferred until the save's `finally` block so the store cannot be deleted while the writer is reading it.

## Memory effect
For a 6000x4000 output, Work230 removes the persistent 288,000,000-byte final RGB RAM allocation from the production path. Work229 had already removed a separate 24,000,000-byte full-resolution 0/255 transparency-mask duplicate.

This does not mean total focus-stack peak memory is only the remaining coverage plane: winner maps, confidence, luminance/alignment data, current tile buffers, runtime/decoder allocations, and other state still exist during processing. Device measurement is still required.

## Tradeoff
The exact final RGB samples now reside in a temporary file instead of persistent RAM. This requires approximately the same 288 MB of temporary storage for a 24 MP result and adds file I/O during blending. The previous save path already created an equivalent file-backed copy later; Work230 moves that representation earlier and removes the persistent RAM copy.

## Quality invariants
Unchanged:
- RAW decode
- calibration
- demosaic
- registration / bicubic sampling
- focus measure
- winner selection
- ordinal regularization
- halo-aware focus blending math
- RGB sample precision (Float32)
- coverage meaning
- camera color transform
- Linear-DNG power-of-two storage normalization
- negative-value preservation
- final DNG `BaselineExposure = 0 EV`

## Validation in this environment
- Node test files: 116
- Node tests: 624/624 PASS
- Native Release CTest: 8/8 PASS
- Native ABI exports: 10/10 PASS
- ASan/UBSan CTest: 8/8 PASS
- shell syntax checks: PASS
- Flutter/Dart analyze/test/build: NOT RUN (Flutter/Dart SDK unavailable in this environment)
- Pixel real-device 24 MP memory measurement: NOT RUN (device unavailable)
- Adobe readback of a Work230-produced DNG: NOT RUN (Adobe unavailable)

## Required next validation
1. Run repository preflight with Flutter 3.44.7 / Java 17.
2. Pixel 9 Pro real-device focus stack with 24 MP Sony ARW: 2, 5, and 10+ frames.
3. Record PSS/RSS during alignment, winner selection, blending, result-idle, and DNG save.
4. Confirm result-idle memory no longer retains the ~288 MB Float32 RGB image.
5. Verify saved DNG in Lightroom / Adobe Camera Raw / Photoshop and compare against Work225+ output for pixel/color/metadata regressions.
