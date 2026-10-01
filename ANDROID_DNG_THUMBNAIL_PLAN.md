# Android DNG thumbnail compatibility plan

STATUS=IMPLEMENTED_AND_REAL_AVD_VERIFIED_PASS
CREATED_JST=2026-08-24T23:55:00+09:00

## Observed fixed-save behavior

- The header-resident transparency SubIFD fix removed the Android
  FuseDaemon/ExifInterface `OutOfMemoryError` completely.
- The only remaining log from the isolated second save is the nonfatal
  `No image meets the size requirements of a thumbnail image.` message.
- Full fixed-file readback remains valid: 72,000,000 finite RGB samples and
  24,000,000 valid transparency-mask pixels.

## AOSP behavior relevant to the fix

Primary source:
`https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/media/java/android/media/ExifInterface.java`

- The first nonzero TIFF `NextIFD` is read as `IFD_TYPE_THUMBNAIL` when that
  slot is empty (around AOSP lines 4244-4259).
- Android accepts a thumbnail only when both dimensions are at most 512 pixels
  (around lines 4485-4498).
- Uncompressed strip thumbnails are accepted when their bits/sample and
  photometric type are supported (around lines 4304-4321 and 4450-4482).

## Planned bounded-memory implementation

1. Reserve a reduced-resolution RGB8 thumbnail IFD and its pixel bytes inside
   the DNG header, before the 288 MB Float32 main raster.
2. Point the main IFD's `NextIFD` at that header-resident thumbnail directory.
   Keep the main IFD `SubIFDs` tag dedicated to the header-resident
   transparency-mask directory.
3. Use `NewSubFileType=1`, dimensions no larger than 256 on the long edge,
   uncompressed chunky RGB, 8/8/8 bits, one strip, and orientation top-left.
4. Generate the thumbnail by sampling bounded source rows from the tile store,
   applying the same validated linear-to-sRGB matrix, percentile exposure,
   and sRGB encoding. Do not materialize another full-resolution image.
5. Add byte-level Classic TIFF and BigTIFF tests, full-file readback coverage,
   Android isolated-save log verification, and another real DNG pull/hash.

The thumbnail directory and pixels must remain near the file header. Placing
either after the 288 MB raster would recreate the forward-seek buffering risk
that the transparency-SubIFD fix removed.

## First AVD save result and corrected linkage plan

The first implementation produced a valid 171x256 RGB8 IFD at offset 1420
with 131328 pixel bytes at offset 1592. The saved 312132920-byte real DNG passed
all 72,000,000 RGB and 24,000,000 mask samples, and Android logged no OOM or
fatal error. The framework still emitted the thumbnail-size message.

AOSP explains the residual: an IFD read through the main `NextIFD` slot uses
`ThumbnailImageWidth`/`ThumbnailImageLength` map keys, while `isThumbnail()`
checks `ImageWidth`/`ImageLength` before the later key-normalization step. A
SubIFD is parsed as the preview slot and retains the keys that `isThumbnail()`
expects. The corrected standards-compatible layout will therefore encode a
classic-TIFF LONG SubIFDs array with the thumbnail first and transparency mask
second, while retaining the main NextIFD thumbnail link. Android reads the
first SubIFD as preview and promotes it; DNG readers can discover both child
IFDs, including the required transparency mask.

## Final AVD verification

The corrected linkage was saved from the preserved real two-ARW focus-stack
result as `focus_stack_20260824_152512.dng` (312132928 bytes, SHA-256
`D046565438C1A0A791FE61A9EC428A7E7D64E8C1FDF04D4C2103BCE97EDA5683`).
The thumbnail IFD is at offset 1428 and its 171x256 RGB8 pixels are at offset
1600, both before the 288 MB main raster. The transparency-mask IFD is at
offset 1300 and remains discoverable as the second SubIFD.

An isolated Android log check found zero Exif OOM, fatal, or missing-thumbnail
candidate messages. Full streaming readback passed 72,000,000 finite Float32
RGB samples, 24,000,000 valid mask bytes, and all 131,328 thumbnail bytes.
Final regressions are 614/614 Node tests, 805/805 Flutter tests, clean Dart
analysis, and a successful Android x64 debug APK build.
