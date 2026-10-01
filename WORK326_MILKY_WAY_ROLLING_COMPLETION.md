# Work326 Milky Way Rolling Accumulator — Completion

## Result

Milky Way background processing now uses a frame-count-independent rolling
pipeline when `automaticMovingObjectRemoval` is OFF. The existing iterative
kappa-sigma path remains unchanged when movement removal is ON.

## Implementation

- First pass decodes one RAW at a time, extracts the exact existing
  registration-star data, commits a compact per-frame checkpoint, and releases
  the full-resolution RGB store.
- Registration planning preserves the existing reference-first frame order,
  best-observed-star baseline, global/local transforms, and comprehensive frame
  weights.
- Second pass retains only the reference plus the current frame and folds the
  registered pixels into FP64 weighted-sum and weight-sum stores.
- Rolling weights are normalized exactly as `TiledKappaSigmaCombiner` does, and
  sampling uses the same 8,192-pixel band geometry so adaptive foreground
  alignment receives identical regions.
- Every completed fold publishes an immutable two-generation recovery
  checkpoint. A torn current manifest falls back to the previous generation.
- FP64 narrows to FP32 only once at finalization. Linear DNG validity is emitted
  from the positive accumulated denominator.
- Start-of-job storage admission is bounded by image dimensions for this mode;
  movement-removal-ON Milky Way retains the frame-count-based estimate.

## Verification

- `flutter analyze`: 0 errors (pre-existing warnings/info remain).
- Flutter tests: 901/901 passed.
- Node regression tests: 711/711 passed.
- Randomized FP32-output comparison: rolling weighted average is bit-identical
  to the existing batch weighted-average path.
- Recovery test: corrupt current checkpoint restores the previous committed
  FP64 generation.
- Android release build succeeded with Flutter 3.44.7 / SDK 36.
- APK signature verification succeeded (v2; project-configured Android Debug
  certificate).
- Pixel 9 API 36 emulator: streamed install succeeded, cold launch succeeded,
  main activity remained resumed, and no fatal exception was logged.

No physical Android device or real astrophotography RAW capture set was
available in this workspace, so a live mid-RAW processor-kill exercise was not
performed. The checkpoint generation/fallback behavior is covered directly by
the automated recovery test.
