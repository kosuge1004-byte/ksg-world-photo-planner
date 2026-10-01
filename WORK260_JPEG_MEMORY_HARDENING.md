# WORK260 JPEG MEMORY HARDENING

## Scope
Work259 identified JPEG export as the remaining full-frame RGB8 allocation path. This work reduces peak Dart-side uncompressed memory without changing tone mapping, JPEG quality, chroma mode, dimensions, or output format.

## Finding
`exportTileStoreToJpeg()` previously allocated a full-resolution `Uint8List rgb`, filled it strip-by-strip, and then constructed `img.Image.fromBytes(...)` from that buffer before encoding. This retained an explicit full-frame RGB8 buffer in addition to the encoder image object. At Sony α7 III 6048x4024, one RGB8 frame is 73,011,456 bytes (~69.63 MiB).

## Change
The exporter now creates the final `img.Image(width, height, numChannels: 3)` first and obtains `image.toUint8List()`, which the image 4.9.2 API documents as a direct view of the image storage. Tone-mapped strips are written straight into that backing store. The intermediate standalone full-frame RGB8 allocation and `Image.fromBytes` reconstruction are removed.

The encoded JPEG byte buffer is still necessarily returned by the current `image` package encoder API, so JPEG is not a fully streaming export. No unverified native JPEG encoder was introduced.

## Quality invariants
- same `_resolveTileStoreToneParameters`
- same `toneMapToDisplayRgb`
- same row/strip ordering
- same JPEG quality default 95
- same `JpegChroma.yuv444`
- no resampling or resizing
- no RAW/registration/stacking/DNG changes

## Regression coverage
Added a JPEG round-trip regression test using a red pixel and green pixel at quality 100. It verifies decoded channel dominance and therefore catches RGB-order corruption in the direct-backing-store path.

## Validation status
Static source checks only in this environment. Flutter/Dart SDK unavailable, so tests/analyze/APK build were not executed. Sony α7 III real RAW was not re-run here.
