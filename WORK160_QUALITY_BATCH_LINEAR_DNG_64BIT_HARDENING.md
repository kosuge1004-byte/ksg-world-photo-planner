# Work160 Quality Batch — Linear DNG 64-bit / Structure Hardening

Status: WIP. Flutter/Dart SDK tests, dart analyze, APK build, and real Adobe-editor interoperability remain unexecuted in this environment.

## Implemented

### 64-bit DNG / BigTIFF
- Added automatic classic-DNG vs 64-bit-DNG container selection.
- Classic DNG remains preferred below the 4 GiB boundary for compatibility.
- 64-bit DNG follows the DNG 64-bit extension:
  - magic 43
  - offset-size field 8
  - reserved field 0
  - 64-bit first-IFD offset
  - 64-bit IFD entry count
  - 64-bit entry counts/value-or-offset fields
  - LONG8 StripOffsets and StripByteCounts
- 32-bit Float LinearRaw payload and the same synthetic linear-sRGB color contract are preserved in both containers.

### DNG structure hardening
- Corrected BigTIFF inline storage rules for SHORT[3] BitsPerSample and SampleFormat.
- Added automatic 64-bit selection based on projected uncompressed Float32 RGB size with metadata safety margin.
- Added Dart regression tests for 64-bit DNG header and container selection.
- Added Node reference generation and 64-bit container tests.
- Added Adobe DNG technology notice required for distribution documentation/source.

### Audited but intentionally not fabricated
- Capture EXIF (ISO, shutter, aperture, lens, date/time) is not currently present in the application's RawFrameMetadata/native ABI. It was not guessed or synthesized.
- OriginalRawFileName is singular by specification and does not faithfully describe a multi-frame stack, so it was not misused as a stack manifest.
- Embedded rendered preview/thumbnail remains unimplemented. Adding one safely requires a defined preview-rendering policy and additional IFD layout work; it does not affect the main Linear DNG image quality.

## Executed validation
- Node reference/regression suite: 373/373 passed.
- Native clean CMake configure/build: passed.
- Native CTest: 8/8 passed.
- Independent `tifffile` parsing:
  - classic Linear DNG: valid, no warnings
  - 64-bit Linear DNG: recognized as BigTIFF, valid, no warnings
  - both: 2x2x3 Float32 LinearRaw
  - DNGVersion 1.4.0.0
  - DefaultBlackRender=None
  - signed -0.25 preserved
  - overrange 4.0 preserved

## Remaining before production release
- Flutter/Dart compile/test/analyze and APK build.
- Lightroom / Camera Raw / Lightroom Classic interoperability test with actual app-generated files.
- Capture EXIF ingestion/propagation if desired.
- Embedded preview/thumbnail if desired.
- Optional lossless Deflate compression for Float32 DNG (quality-neutral, storage/CPU tradeoff).
