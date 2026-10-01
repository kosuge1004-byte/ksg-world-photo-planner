# Work258 — Streamed Linear DNG validity-mask memory audit

## Scope
Continued the Work257 zero-base audit into Linear DNG export memory use, validity-mask construction, repeated full-frame scans, and temporary-resource lifetime.

## Finding
The production Milky Way / robust-stack Linear DNG path supplied a file-backed `LinearContributionTileStore`, but `_exportLinearDngWithoutRenderedAdjustments()` first materialized the entire output validity mask as a `Uint8List(width * height)` through `buildLinearDngTransparencyMask()`.

For a Sony A7 III full-resolution 6048 x 4024 image this allocation alone is 24,337,152 bytes (~23.2 MiB), in addition to RGB strip buffers, thumbnail buffers, contribution-store read buffers, Dart/Flutter overhead, and native decode memory. The mask was derived from already-file-backed contribution counts, so the full-frame allocation was unnecessary.

## Fix
- Added optional `LinearContributionTileStore contributionStore` directly to `exportTileStoreToLinearDng()`.
- The writer now reserves the DNG TransparencyMask IFD as before, but emits the mask in bounded 128-row chunks by reading the contribution store on demand.
- A pixel is valid only when R/G/B surviving contribution counts are all > 0, preserving the existing fail-closed semantics.
- Cancellation is checked before each read and during large per-chunk scans.
- Existing `transparencyMask` and `binaryValidityMask` inputs remain supported for backward compatibility (including focus-stack coverage).
- The production export wrapper no longer calls `buildLinearDngTransparencyMask()` when a contribution store is available; it passes the store directly to the DNG writer.
- Existing full-mask utility remains present for callers/tests that explicitly need a materialized mask.

## Peak-memory effect
At 6048 pixels wide and 128 rows, the emitted mask buffer is about 774 KiB instead of ~23.2 MiB for the full-frame mask. The contribution read tile remains bounded by the same row window. Exact process peak memory still requires Android runtime profiling and is NOT VERIFIED here.

## Quality impact
No image-quality algorithm was changed. The validity definition, contribution counts, RGB raster, DNG float encoding, color transform, highlight headroom, transparency semantics, and robust stacking are unchanged.

## Tests
Added a Linear DNG writer regression test that supplies a contribution store directly and verifies resulting TransparencyMask bytes `[255, 0, 255, 0]` for known RGB-channel contribution counts.

## Verification status
- Static source inspection: PASS
- Full-frame validity materialization removed from production contribution-store DNG path: PASS
- Streaming contribution-store mask path present: PASS
- Mutual exclusivity of mask sources enforced: PASS
- Cancellation checks in streamed mask write: PASS
- Regression test added: PASS
- `flutter test`: NOT RUN (Flutter SDK unavailable)
- `flutter analyze`: NOT RUN (Flutter SDK unavailable)
- Android release APK: NOT BUILT
- Sony A7 III real RAW: NOT VERIFIED
