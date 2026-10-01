# Work306 — Final focus coverage mask file-backed

## Confirmed Work305 remaining allocation
The Work305 focus-stack result still retained one full-image Uint8 coverage
array until export. At 60 MP this is ~60 MB decimal.

## Work306 change
The production focus blend now writes validity per tile to
`FileBackedFocusCoverageMask`.

The file stores DNG TransparencyMask bytes directly:
- 0 = invalid
- 255 = valid

`FocusStackPipelineResult` owns the file-backed mask instead of a full
`Uint8List`. Linear DNG export passes it through the existing
`LinearDngTransparencyMaskSource` interface, which already reads only bounded
row blocks.

JPEG/TIFF export does not require this mask, but the result keeps it until
dispose so a later DNG export remains possible.

## Quality / semantics
- Final focus blend RGB math unchanged.
- Existing per-tile `blended.coverage` is still the source of truth.
- Binary 0/1 coverage is encoded exactly as 0/255 DNG transparency.
- DNG writer code and Native code are unchanged.
- Old in-memory blender APIs are retained for tests/compatibility.

## Memory effect
Removes the final long-lived 1 byte/pixel focus coverage allocation:
- 33 MP ~33 MB decimal
- 60 MP ~60 MB decimal

Only tile-sized coverage buffers are resident during blending/export.

## Validation here
- Static wiring/source checks.
- File-backed 0/1 -> 0/255 test source added.
- Native tree unchanged.
- ZIP CRC PASS.
- Dart/Flutter SDK unavailable, so Dart tests/analyze/APK/device RSS not run.
