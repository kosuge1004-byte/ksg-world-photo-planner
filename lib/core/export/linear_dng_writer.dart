import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import '../color/dng_d65_color_transform.dart';
import '../color/linear_rgb_color_transform.dart';
import '../image/linear_rgb_tile_store.dart';
import '../image/linear_contribution_tile_store.dart';

class InvalidLinearDngInput extends ArgumentError {
  InvalidLinearDngInput(super.message);
}

class LinearDngExportCancelled implements Exception {
  const LinearDngExportCancelled();

  @override
  String toString() => 'Linear DNG export was cancelled.';
}

final class LinearDngHeader {
  const LinearDngHeader({
    required this.bytes,
    required this.pixelDataOffset,
    required this.stripOffsets,
    required this.stripByteCounts,
    required this.imageDataEndOffset,
    required this.transparencyMaskDataOffset,
    required this.thumbnailIfdOffset,
    required this.thumbnailDataOffset,
    required this.isBigTiff,
  });

  final Uint8List bytes;
  final int pixelDataOffset;
  final List<int> stripOffsets;
  final List<int> stripByteCounts;
  final int imageDataEndOffset;
  final int? transparencyMaskDataOffset;
  final int? thumbnailIfdOffset;
  final int? thumbnailDataOffset;
  final bool isBigTiff;
}

final class LinearDngThumbnail {
  const LinearDngThumbnail({
    required this.width,
    required this.height,
    required this.interleavedSrgb8,
  });

  final int width;
  final int height;
  final Uint8List interleavedSrgb8;
}

/// Row-addressable source for a binary DNG TransparencyMask.
///
/// Implementations let export paths derive validity from file-backed coverage
/// data without first materializing a full `width * height` Uint8List in RAM.
/// Returned bytes must be 0 (invalid) or 255 (valid).
abstract interface class LinearDngTransparencyMaskSource {
  int get width;
  int get height;

  Future<Uint8List> readRows({
    required int startY,
    required int rowCount,
  });
}

const int classicLinearDngMaximumOffset = 0xffffffff;

enum LinearDngContainer { classic, bigTiff }

enum LinearDngCompression { none, deflate }

/// Capture provenance that can be written without inventing a single
/// "representative" exposure for a multi-frame stack.
///
/// Only values that are known to be common to every contributing frame should
/// be supplied. Per-frame ISO/shutter/aperture/date-time belong in a separate
/// stack manifest until the application preserves them frame-by-frame.
final class LinearDngProvenance {
  const LinearDngProvenance({
    this.cameraMake,
    this.cameraModel,
    this.lensModel,
    this.sourceFrameCount,
  });

  final String? cameraMake;
  final String? cameraModel;
  final String? lensModel;
  final int? sourceFrameCount;

  String? get imageDescription {
    final int? count = sourceFrameCount;
    return count == null
        ? null
        : 'Linear stack composed from $count RAW frames';
  }
}

LinearDngContainer recommendedLinearDngContainer({
  required int width,
  required int height,
  bool includeTransparencyMask = false,
}) {
  if (width <= 0 || height <= 0) {
    throw InvalidLinearDngInput('width and height must be positive.');
  }
  // 3 channels * 4 bytes Float32. Metadata is small relative to pixels;
  // reserve 1 MiB so a file close to the uint32 boundary cannot overflow.
  const int metadataSafetyMargin = 1024 * 1024;
  final int pixelCount = width * height;
  final int projected = pixelCount * 12 +
      (includeTransparencyMask ? pixelCount : 0) +
      metadataSafetyMargin;
  return projected > classicLinearDngMaximumOffset
      ? LinearDngContainer.bigTiff
      : LinearDngContainer.classic;
}

const int _d65ExifLightSource = 21;
const int _dngPhotometricLinearRaw = 34892;
const int _dngVersionInlineLittleEndian = 0x00000401; // bytes 1,4,0,0
const int _dngBackwardVersionInlineLittleEndian =
    0x00000401; // bytes 1,4,0,0: Float32/transparent-pixel minimum
const int _transparencyMaskIfdEntryCount = 10;
const int _thumbnailIfdEntryCount = 13;

void _validateThumbnail(LinearDngThumbnail? thumbnail) {
  if (thumbnail == null) return;
  if (thumbnail.width <= 0 ||
      thumbnail.height <= 0 ||
      thumbnail.width > 512 ||
      thumbnail.height > 512) {
    throw InvalidLinearDngInput(
      'Linear DNG thumbnail dimensions must be in the range 1..512.',
    );
  }
  if (thumbnail.interleavedSrgb8.length !=
      thumbnail.width * thumbnail.height * 3) {
    throw InvalidLinearDngInput(
      'Linear DNG thumbnail RGB8 sample count does not match dimensions.',
    );
  }
}

int _align4(int value) => (value + 3) & ~3;
int _align8(int value) => (value + 7) & ~7;

int _checkedUint32(int value, String label) {
  if (value < 0 || value > classicLinearDngMaximumOffset) {
    throw InvalidLinearDngInput(
        '$label exceeds classic TIFF/DNG uint32 range.');
  }
  return value;
}

/// Encodes the metadata prefix for a classic little-endian DNG whose main
/// image is 3-channel, 32-bit IEEE floating-point LinearRaw data.
///
/// The stored color space is a synthetic "MobileStack Linear sRGB" camera
/// space. ColorMatrix1 therefore maps D65 XYZ to linear sRGB and
/// AsShotWhiteXY records the D65 neutral already baked into the stored RGB.
/// The image is already in linear reference values;
/// no creative tone curve, LUT, gamma encoding, or exposure adjustment is
/// embedded in the samples.
LinearDngHeader encodeLinearDngFloat32Header({
  required int width,
  required int height,
  int rowsPerStrip = 64,
  String uniqueCameraModel = 'MobileStack Linear sRGB',
  String software = 'Mobile Stack',
  List<double> colorMatrix1 = d65XyzToLinearSrgb,
  bool includeTransparencyMask = false,
  LinearDngThumbnail? thumbnail,
  int baselineExposureEv = 0,
  LinearDngCompression compression = LinearDngCompression.none,
  List<int>? encodedStripByteCounts,
}) {
  if (width <= 0 || height <= 0 || rowsPerStrip <= 0) {
    throw InvalidLinearDngInput(
      'width, height and rowsPerStrip must be positive.',
    );
  }
  if (baselineExposureEv < 0 || baselineExposureEv > 128) {
    throw InvalidLinearDngInput(
      'baselineExposureEv must be in the lossless headroom range 0..128.',
    );
  }
  final int stripCount = (height + rowsPerStrip - 1) ~/ rowsPerStrip;
  if (encodedStripByteCounts != null &&
      (encodedStripByteCounts.length != stripCount ||
          encodedStripByteCounts.any((int value) => value <= 0))) {
    throw InvalidLinearDngInput(
      'Encoded strip byte counts do not match the image strip layout.',
    );
  }
  if (compression == LinearDngCompression.deflate &&
      encodedStripByteCounts == null) {
    throw InvalidLinearDngInput(
      'Deflate DNG requires the encoded byte count of every strip.',
    );
  }
  final int projectedPixelBytes = encodedStripByteCounts?.fold<int>(
        0,
        (int sum, int value) => sum + value,
      ) ??
      width * height * 3 * 4;
  if (projectedPixelBytes <= 0) {
    throw InvalidLinearDngInput(
      'Projected Linear DNG image byte count must be positive.',
    );
  }
  if (colorMatrix1.length != 9 ||
      colorMatrix1.any((double value) => !value.isFinite)) {
    throw InvalidLinearDngInput('ColorMatrix1 must contain 9 finite values.');
  }
  if (uniqueCameraModel.isEmpty || uniqueCameraModel.contains('\u0000')) {
    throw InvalidLinearDngInput(
      'UniqueCameraModel must be a non-empty NUL-free string.',
    );
  }
  if (software.isEmpty || software.contains('\u0000')) {
    throw InvalidLinearDngInput(
        'Software must be a non-empty NUL-free string.');
  }
  _validateThumbnail(thumbnail);

  final Uint8List modelBytes =
      Uint8List.fromList(<int>[...utf8.encode(uniqueCameraModel), 0]);
  final Uint8List softwareBytes =
      Uint8List.fromList(<int>[...utf8.encode(software), 0]);

  final int subIfdCount =
      (thumbnail == null ? 0 : 1) + (includeTransparencyMask ? 1 : 0);
  final int entryCount = subIfdCount > 0 ? 27 : 26;
  const int ifdOffset = 8;
  final int ifdByteLength = 2 + entryCount * 12 + 4;
  int cursor = _align4(ifdOffset + ifdByteLength);

  final int bitsPerSampleOffset = cursor;
  cursor = _align4(cursor + 6);

  final int sampleFormatOffset = cursor;
  cursor = _align4(cursor + 6);

  final int softwareOffset = cursor;
  cursor = _align4(cursor + softwareBytes.length);

  final int modelOffset = cursor;
  cursor = _align4(cursor + modelBytes.length);

  final int colorMatrixOffset = cursor;
  cursor = _align4(cursor + 9 * 8); // SRATIONAL = 2 x int32

  final int asShotWhiteXyOffset = cursor;
  cursor = _align4(cursor + 2 * 8); // RATIONAL x2

  final int defaultCropOriginOffset = cursor;
  cursor = _align4(cursor + 2 * 8); // RATIONAL x2
  final int defaultCropSizeOffset = cursor;
  cursor = _align4(cursor + 2 * 8); // RATIONAL x2
  final int activeAreaDataOffset = cursor;
  cursor = _align4(cursor + 4 * 4); // LONG x4
  final int baselineExposureOffset = cursor;
  cursor = _align4(cursor + 8); // SRATIONAL x1

  final int stripOffsetsArrayOffset = stripCount > 1 ? cursor : 0;
  if (stripCount > 1) cursor = _align4(cursor + stripCount * 4);

  final int stripByteCountsArrayOffset = stripCount > 1 ? cursor : 0;
  if (stripCount > 1) cursor = _align4(cursor + stripCount * 4);

  final int? subIfdOffsetsArrayOffset =
      subIfdCount > 1 ? _align4(cursor) : null;
  if (subIfdOffsetsArrayOffset != null) {
    cursor = _align4(subIfdOffsetsArrayOffset + subIfdCount * 4);
  }

  final int? transparencyIfdOffset =
      includeTransparencyMask ? _align4(cursor) : null;
  if (transparencyIfdOffset != null) {
    const int transparencyIfdLength =
        2 + _transparencyMaskIfdEntryCount * 12 + 4;
    cursor = _align4(transparencyIfdOffset + transparencyIfdLength);
  }

  final int? thumbnailIfdOffset = thumbnail == null ? null : _align4(cursor);
  int? thumbnailBitsPerSampleOffset;
  int? thumbnailDataOffset;
  if (thumbnailIfdOffset != null) {
    const int thumbnailIfdLength = 2 + _thumbnailIfdEntryCount * 12 + 4;
    cursor = _align4(thumbnailIfdOffset + thumbnailIfdLength);
    thumbnailBitsPerSampleOffset = cursor;
    cursor = _align4(cursor + 6);
    thumbnailDataOffset = cursor;
    cursor = _align4(cursor + thumbnail!.interleavedSrgb8.length);
  }

  final int pixelDataOffset =
      _checkedUint32(_align4(cursor), 'pixelDataOffset');

  final List<int> stripOffsets = <int>[];
  final List<int> stripByteCounts = <int>[];
  int nextOffset = pixelDataOffset;
  for (int strip = 0; strip < stripCount; strip++) {
    final int startRow = strip * rowsPerStrip;
    final int rowCount = (height - startRow).clamp(0, rowsPerStrip).toInt();
    final int byteCount =
        encodedStripByteCounts?[strip] ?? width * rowCount * 3 * 4;
    _checkedUint32(byteCount, 'stripByteCount');
    stripOffsets.add(_checkedUint32(nextOffset, 'stripOffset'));
    stripByteCounts.add(byteCount);
    nextOffset = _checkedUint32(nextOffset + byteCount, 'DNG file size');
  }
  final int? transparencyMaskDataOffset = includeTransparencyMask
      ? _checkedUint32(_align4(nextOffset), 'transparencyMaskDataOffset')
      : null;
  if (transparencyMaskDataOffset != null) {
    _checkedUint32(
      transparencyMaskDataOffset + width * height,
      'DNG file size',
    );
  }

  final Uint8List header = Uint8List(pixelDataOffset);
  final ByteData data = ByteData.sublistView(header);

  header[0] = 0x49; // II
  header[1] = 0x49;
  data.setUint16(2, 42, Endian.little);
  data.setUint32(4, ifdOffset, Endian.little);
  data.setUint16(ifdOffset, entryCount, Endian.little);

  int entryOffset = ifdOffset + 2;
  void writeEntry(int tag, int type, int count, int valueOrOffset) {
    data.setUint16(entryOffset, tag, Endian.little);
    data.setUint16(entryOffset + 2, type, Endian.little);
    data.setUint32(entryOffset + 4, count, Endian.little);
    data.setUint32(entryOffset + 8, valueOrOffset, Endian.little);
    entryOffset += 12;
  }

  const int byteType = 1;
  const int asciiType = 2;
  const int shortType = 3;
  const int longType = 4;
  const int rationalType = 5;
  const int signedRationalType = 10;

  writeEntry(254, longType, 1, 0); // NewSubFileType = full-resolution raw
  writeEntry(256, longType, 1, width);
  writeEntry(257, longType, 1, height);
  writeEntry(258, shortType, 3, bitsPerSampleOffset);
  writeEntry(
    259,
    shortType,
    1,
    compression == LinearDngCompression.deflate ? 8 : 1,
  );
  // Compression = none remains the maximum-compatibility default; the
  // Lightroom lossless preset explicitly selects DNG 1.4 Deflate (8).
  writeEntry(262, shortType, 1, _dngPhotometricLinearRaw);
  writeEntry(
    273,
    longType,
    stripCount,
    stripCount == 1 ? stripOffsets.single : stripOffsetsArrayOffset,
  );
  writeEntry(274, shortType, 1, 1); // Orientation = top-left
  writeEntry(277, shortType, 1, 3); // SamplesPerPixel
  writeEntry(278, longType, 1, rowsPerStrip);
  writeEntry(
    279,
    longType,
    stripCount,
    stripCount == 1 ? stripByteCounts.single : stripByteCountsArrayOffset,
  );
  writeEntry(284, shortType, 1, 1); // PlanarConfiguration = chunky
  writeEntry(305, asciiType, softwareBytes.length, softwareOffset);
  if (subIfdCount > 0) {
    final int directOffset = thumbnailIfdOffset ?? transparencyIfdOffset!;
    writeEntry(
      330,
      longType,
      subIfdCount,
      subIfdOffsetsArrayOffset ?? directOffset,
    ); // SubIFDs -> thumbnail first, then transparency mask.
  }
  writeEntry(339, shortType, 3, sampleFormatOffset); // IEEE float x3
  writeEntry(50706, byteType, 4, _dngVersionInlineLittleEndian);
  writeEntry(50707, byteType, 4, _dngBackwardVersionInlineLittleEndian);
  writeEntry(50708, asciiType, modelBytes.length, modelOffset);
  // BlackLevel is omitted: the DNG-defined default is 0, matching the
  // already black-calibrated scene-linear stack. Float LinearRaw also omits
  // WhiteLevel: the DNG-defined default is 1.0.
  writeEntry(50730, signedRationalType, 1, baselineExposureOffset);
  writeEntry(50719, rationalType, 2, defaultCropOriginOffset);
  writeEntry(50720, rationalType, 2, defaultCropSizeOffset);
  writeEntry(50721, signedRationalType, 9, colorMatrixOffset);
  writeEntry(50729, rationalType, 2, asShotWhiteXyOffset);
  writeEntry(50778, shortType, 1, _d65ExifLightSource);
  writeEntry(50879, shortType, 1, 0); // ColorimetricReference = scene-referred
  writeEntry(50829, longType, 4, activeAreaDataOffset); // top,left,bottom,right
  // The stored samples have already had sensor black calibration applied.
  // Prevent a raw converter from applying an additional image-dependent
  // black rendering subtraction on top of the calibrated stack.
  writeEntry(51110, longType, 1, 1); // DefaultBlackRender = None

  data.setUint32(
    entryOffset,
    thumbnailIfdOffset ?? 0,
    Endian.little,
  );

  for (int channel = 0; channel < 3; channel++) {
    data.setUint16(bitsPerSampleOffset + channel * 2, 32, Endian.little);
    data.setUint16(sampleFormatOffset + channel * 2, 3, Endian.little);
  }
  header.setRange(
    softwareOffset,
    softwareOffset + softwareBytes.length,
    softwareBytes,
  );
  header.setRange(modelOffset, modelOffset + modelBytes.length, modelBytes);

  const int matrixDenominator = 100000000;
  for (int index = 0; index < 9; index++) {
    final int numerator = (colorMatrix1[index] * matrixDenominator).round();
    if (numerator < -0x80000000 || numerator > 0x7fffffff) {
      throw InvalidLinearDngInput('ColorMatrix1 rational overflow.');
    }
    final int offset = colorMatrixOffset + index * 8;
    data.setInt32(offset, numerator, Endian.little);
    data.setInt32(offset + 4, matrixDenominator, Endian.little);
  }

  // Stored samples are already white-balanced scene-linear sRGB/D65.
  // ColorimetricReference=0 keeps the DNG scene-referred; AsShotWhiteXY=D65
  // records the neutral already baked into these synthetic camera coordinates.
  data.setUint32(asShotWhiteXyOffset, 3127, Endian.little);
  data.setUint32(asShotWhiteXyOffset + 4, 10000, Endian.little);
  data.setUint32(asShotWhiteXyOffset + 8, 3290, Endian.little);
  data.setUint32(asShotWhiteXyOffset + 12, 10000, Endian.little);
  // The stack output has no hidden sensor border: the complete stored raster
  // is both the active area and the default crop.
  for (int i = 0; i < 2; i++) {
    final int originOffset = defaultCropOriginOffset + i * 8;
    data.setUint32(originOffset, 0, Endian.little);
    data.setUint32(originOffset + 4, 1, Endian.little);
  }
  data.setUint32(defaultCropSizeOffset, width, Endian.little);
  data.setUint32(defaultCropSizeOffset + 4, 1, Endian.little);
  data.setUint32(defaultCropSizeOffset + 8, height, Endian.little);
  data.setUint32(defaultCropSizeOffset + 12, 1, Endian.little);
  data.setUint32(activeAreaDataOffset, 0, Endian.little);
  data.setUint32(activeAreaDataOffset + 4, 0, Endian.little);
  data.setUint32(activeAreaDataOffset + 8, height, Endian.little);
  data.setUint32(activeAreaDataOffset + 12, width, Endian.little);
  data.setInt32(baselineExposureOffset, baselineExposureEv, Endian.little);
  data.setInt32(baselineExposureOffset + 4, 1, Endian.little);

  if (stripCount > 1) {
    for (int index = 0; index < stripCount; index++) {
      data.setUint32(
        stripOffsetsArrayOffset + index * 4,
        stripOffsets[index],
        Endian.little,
      );
      data.setUint32(
        stripByteCountsArrayOffset + index * 4,
        stripByteCounts[index],
        Endian.little,
      );
    }
  }

  if (subIfdOffsetsArrayOffset != null) {
    int offset = subIfdOffsetsArrayOffset;
    if (thumbnailIfdOffset != null) {
      data.setUint32(offset, thumbnailIfdOffset, Endian.little);
      offset += 4;
    }
    if (transparencyIfdOffset != null) {
      data.setUint32(offset, transparencyIfdOffset, Endian.little);
    }
  }

  if (transparencyIfdOffset != null && transparencyMaskDataOffset != null) {
    final _TransparencyMaskDirectory directory =
        _buildTransparencyMaskDirectory(
      width: width,
      height: height,
      ifdOffset: transparencyIfdOffset,
      maskDataOffset: transparencyMaskDataOffset,
      bigTiff: false,
    );
    header.setRange(
      transparencyIfdOffset,
      transparencyIfdOffset + directory.directoryBytes.length,
      directory.directoryBytes,
    );
  }

  if (thumbnail != null &&
      thumbnailIfdOffset != null &&
      thumbnailBitsPerSampleOffset != null &&
      thumbnailDataOffset != null) {
    _writeClassicThumbnail(
      header: header,
      thumbnail: thumbnail,
      ifdOffset: thumbnailIfdOffset,
      bitsPerSampleOffset: thumbnailBitsPerSampleOffset,
      dataOffset: thumbnailDataOffset,
    );
  }

  return LinearDngHeader(
    bytes: header,
    pixelDataOffset: pixelDataOffset,
    stripOffsets: List<int>.unmodifiable(stripOffsets),
    stripByteCounts: List<int>.unmodifiable(stripByteCounts),
    imageDataEndOffset: nextOffset,
    transparencyMaskDataOffset: transparencyMaskDataOffset,
    thumbnailIfdOffset: thumbnailIfdOffset,
    thumbnailDataOffset: thumbnailDataOffset,
    isBigTiff: false,
  );
}

void _writeClassicThumbnail({
  required Uint8List header,
  required LinearDngThumbnail thumbnail,
  required int ifdOffset,
  required int bitsPerSampleOffset,
  required int dataOffset,
}) {
  final ByteData data = ByteData.sublistView(header);
  data.setUint16(ifdOffset, _thumbnailIfdEntryCount, Endian.little);
  int entryOffset = ifdOffset + 2;
  void writeEntry(int tag, int type, int count, int valueOrOffset) {
    data.setUint16(entryOffset, tag, Endian.little);
    data.setUint16(entryOffset + 2, type, Endian.little);
    data.setUint32(entryOffset + 4, count, Endian.little);
    data.setUint32(entryOffset + 8, valueOrOffset, Endian.little);
    entryOffset += 12;
  }

  const int shortType = 3;
  const int longType = 4;
  writeEntry(254, longType, 1, 1); // Reduced-resolution image.
  writeEntry(256, longType, 1, thumbnail.width);
  writeEntry(257, longType, 1, thumbnail.height);
  writeEntry(258, shortType, 3, bitsPerSampleOffset);
  writeEntry(259, shortType, 1, 1); // Uncompressed.
  writeEntry(262, shortType, 1, 2); // RGB.
  writeEntry(273, longType, 1, dataOffset);
  writeEntry(274, shortType, 1, 1); // Top-left.
  writeEntry(277, shortType, 1, 3);
  writeEntry(278, longType, 1, thumbnail.height);
  writeEntry(279, longType, 1, thumbnail.interleavedSrgb8.length);
  writeEntry(284, shortType, 1, 1); // Chunky.
  writeEntry(50970, shortType, 1, 1); // PreviewColorSpace = sRGB.
  data.setUint32(entryOffset, 0, Endian.little);
  for (int channel = 0; channel < 3; channel++) {
    data.setUint16(bitsPerSampleOffset + channel * 2, 8, Endian.little);
  }
  header.setRange(
    dataOffset,
    dataOffset + thumbnail.interleavedSrgb8.length,
    thumbnail.interleavedSrgb8,
  );
}

void _writeBigThumbnail({
  required Uint8List header,
  required LinearDngThumbnail thumbnail,
  required int ifdOffset,
  required int dataOffset,
}) {
  final ByteData data = ByteData.sublistView(header);
  data.setUint64(ifdOffset, _thumbnailIfdEntryCount, Endian.little);
  int entryOffset = ifdOffset + 8;
  void writeEntry(int tag, int type, int count, int valueOrOffset) {
    data.setUint16(entryOffset, tag, Endian.little);
    data.setUint16(entryOffset + 2, type, Endian.little);
    data.setUint64(entryOffset + 4, count, Endian.little);
    data.setUint64(entryOffset + 12, valueOrOffset, Endian.little);
    entryOffset += 20;
  }

  const int shortType = 3;
  const int longType = 4;
  const int long8Type = 16;
  writeEntry(254, longType, 1, 1);
  writeEntry(256, longType, 1, thumbnail.width);
  writeEntry(257, longType, 1, thumbnail.height);
  writeEntry(258, shortType, 3, 8 | (8 << 16) | (8 << 32));
  writeEntry(259, shortType, 1, 1);
  writeEntry(262, shortType, 1, 2);
  writeEntry(273, long8Type, 1, dataOffset);
  writeEntry(274, shortType, 1, 1);
  writeEntry(277, shortType, 1, 3);
  writeEntry(278, longType, 1, thumbnail.height);
  writeEntry(279, long8Type, 1, thumbnail.interleavedSrgb8.length);
  writeEntry(284, shortType, 1, 1);
  writeEntry(50970, shortType, 1, 1);
  data.setUint64(entryOffset, 0, Endian.little);
  header.setRange(
    dataOffset,
    dataOffset + thumbnail.interleavedSrgb8.length,
    thumbnail.interleavedSrgb8,
  );
}

/// Encodes the same LinearRaw contract as [encodeLinearDngFloat32Header]
/// using the DNG 64-bit TIFF extension (BigTIFF).
LinearDngHeader encodeBigLinearDngFloat32Header({
  required int width,
  required int height,
  int rowsPerStrip = 64,
  String uniqueCameraModel = 'MobileStack Linear sRGB',
  String software = 'Mobile Stack',
  List<double> colorMatrix1 = d65XyzToLinearSrgb,
  bool includeTransparencyMask = false,
  LinearDngThumbnail? thumbnail,
  int baselineExposureEv = 0,
}) {
  if (width <= 0 || height <= 0 || rowsPerStrip <= 0) {
    throw InvalidLinearDngInput(
      'width, height and rowsPerStrip must be positive.',
    );
  }
  if (baselineExposureEv < 0 || baselineExposureEv > 128) {
    throw InvalidLinearDngInput(
      'baselineExposureEv must be in the lossless headroom range 0..128.',
    );
  }
  final int projectedPixelBytes = width * height * 3 * 4;
  if (projectedPixelBytes <= 0) {
    throw InvalidLinearDngInput(
      'Projected Linear DNG image byte count must be positive.',
    );
  }
  if (colorMatrix1.length != 9 ||
      colorMatrix1.any((double value) => !value.isFinite)) {
    throw InvalidLinearDngInput('ColorMatrix1 must contain 9 finite values.');
  }
  if (uniqueCameraModel.isEmpty || uniqueCameraModel.contains('\u0000')) {
    throw InvalidLinearDngInput(
      'UniqueCameraModel must be a non-empty NUL-free string.',
    );
  }
  if (software.isEmpty || software.contains('\u0000')) {
    throw InvalidLinearDngInput(
        'Software must be a non-empty NUL-free string.');
  }
  _validateThumbnail(thumbnail);

  final Uint8List modelBytes =
      Uint8List.fromList(<int>[...utf8.encode(uniqueCameraModel), 0]);
  final Uint8List softwareBytes =
      Uint8List.fromList(<int>[...utf8.encode(software), 0]);

  final int subIfdCount =
      (thumbnail == null ? 0 : 1) + (includeTransparencyMask ? 1 : 0);
  final int entryCount = subIfdCount > 0 ? 27 : 26;
  const int ifdOffset = 16;
  final int ifdByteLength = 8 + entryCount * 20 + 8;
  int cursor = _align8(ifdOffset + ifdByteLength);

  final int softwareOffset = cursor;
  cursor = _align8(cursor + softwareBytes.length);
  final int modelOffset = cursor;
  cursor = _align8(cursor + modelBytes.length);
  final int colorMatrixOffset = cursor;
  cursor = _align8(cursor + 9 * 8);
  final int asShotWhiteXyOffset = cursor;
  cursor = _align8(cursor + 2 * 8);
  final int defaultCropOriginOffset = cursor;
  cursor = _align8(cursor + 2 * 8);
  final int defaultCropSizeOffset = cursor;
  cursor = _align8(cursor + 2 * 8);
  final int activeAreaDataOffset = cursor;
  cursor = _align8(cursor + 4 * 4);
  final int baselineExposureOffset = cursor;
  cursor = _align8(cursor + 8); // SRATIONAL x1

  final int stripCount = (height + rowsPerStrip - 1) ~/ rowsPerStrip;
  final int stripOffsetsArrayOffset = stripCount > 1 ? cursor : 0;
  if (stripCount > 1) cursor = _align8(cursor + stripCount * 8);
  final int stripByteCountsArrayOffset = stripCount > 1 ? cursor : 0;
  if (stripCount > 1) cursor = _align8(cursor + stripCount * 8);

  final int? subIfdOffsetsArrayOffset =
      subIfdCount > 1 ? _align8(cursor) : null;
  if (subIfdOffsetsArrayOffset != null) {
    cursor = _align8(subIfdOffsetsArrayOffset + subIfdCount * 8);
  }

  final int? transparencyIfdOffset =
      includeTransparencyMask ? _align8(cursor) : null;
  if (transparencyIfdOffset != null) {
    const int transparencyIfdLength =
        8 + _transparencyMaskIfdEntryCount * 20 + 8;
    cursor = _align8(transparencyIfdOffset + transparencyIfdLength);
  }

  final int? thumbnailIfdOffset = thumbnail == null ? null : _align8(cursor);
  int? thumbnailDataOffset;
  if (thumbnailIfdOffset != null) {
    const int thumbnailIfdLength = 8 + _thumbnailIfdEntryCount * 20 + 8;
    cursor = _align8(thumbnailIfdOffset + thumbnailIfdLength);
    thumbnailDataOffset = cursor;
    cursor = _align8(cursor + thumbnail!.interleavedSrgb8.length);
  }

  final int pixelDataOffset = _align8(cursor);
  final List<int> stripOffsets = <int>[];
  final List<int> stripByteCounts = <int>[];
  int nextOffset = pixelDataOffset;
  for (int strip = 0; strip < stripCount; strip++) {
    final int startRow = strip * rowsPerStrip;
    final int rowCount = (height - startRow).clamp(0, rowsPerStrip).toInt();
    final int byteCount = width * rowCount * 3 * 4;
    if (byteCount < 0) {
      throw InvalidLinearDngInput('Invalid 64-bit strip byte count.');
    }
    stripOffsets.add(nextOffset);
    stripByteCounts.add(byteCount);
    nextOffset += byteCount;
  }
  final int? transparencyMaskDataOffset =
      includeTransparencyMask ? _align8(nextOffset) : null;

  final Uint8List header = Uint8List(pixelDataOffset);
  final ByteData data = ByteData.sublistView(header);
  header[0] = 0x49;
  header[1] = 0x49;
  data.setUint16(2, 43, Endian.little);
  data.setUint16(4, 8, Endian.little);
  data.setUint16(6, 0, Endian.little);
  data.setUint64(8, ifdOffset, Endian.little);
  data.setUint64(ifdOffset, entryCount, Endian.little);

  int entryOffset = ifdOffset + 8;
  void writeEntry(int tag, int type, int count, int valueOrOffset) {
    data.setUint16(entryOffset, tag, Endian.little);
    data.setUint16(entryOffset + 2, type, Endian.little);
    data.setUint64(entryOffset + 4, count, Endian.little);
    data.setUint64(entryOffset + 12, valueOrOffset, Endian.little);
    entryOffset += 20;
  }

  const int byteType = 1;
  const int asciiType = 2;
  const int shortType = 3;
  const int longType = 4;
  const int rationalType = 5;
  const int signedRationalType = 10;
  const int long8Type = 16;
  const int ifd8Type = 18;

  writeEntry(254, longType, 1, 0);
  writeEntry(256, longType, 1, width);
  writeEntry(257, longType, 1, height);
  writeEntry(
    258,
    shortType,
    3,
    32 | (32 << 16) | (32 << 32),
  );
  writeEntry(259, shortType, 1, 1);
  writeEntry(262, shortType, 1, _dngPhotometricLinearRaw);
  writeEntry(
    273,
    long8Type,
    stripCount,
    stripCount == 1 ? stripOffsets.single : stripOffsetsArrayOffset,
  );
  writeEntry(274, shortType, 1, 1);
  writeEntry(277, shortType, 1, 3);
  writeEntry(278, longType, 1, rowsPerStrip);
  writeEntry(
    279,
    long8Type,
    stripCount,
    stripCount == 1 ? stripByteCounts.single : stripByteCountsArrayOffset,
  );
  writeEntry(284, shortType, 1, 1);
  writeEntry(305, asciiType, softwareBytes.length, softwareOffset);
  if (subIfdCount > 0) {
    final int directOffset = thumbnailIfdOffset ?? transparencyIfdOffset!;
    writeEntry(
      330,
      ifd8Type,
      subIfdCount,
      subIfdOffsetsArrayOffset ?? directOffset,
    ); // SubIFDs -> thumbnail first, then transparency mask.
  }
  writeEntry(339, shortType, 3, 3 | (3 << 16) | (3 << 32));
  writeEntry(50706, byteType, 4, _dngVersionInlineLittleEndian);
  writeEntry(50707, byteType, 4, _dngBackwardVersionInlineLittleEndian);
  writeEntry(50708, asciiType, modelBytes.length, modelOffset);
  // BlackLevel is omitted: the DNG-defined default is 0, matching the
  // already black-calibrated scene-linear stack. Float LinearRaw also omits
  // WhiteLevel: the DNG-defined default is 1.0.
  writeEntry(50730, signedRationalType, 1, baselineExposureOffset);
  writeEntry(50719, rationalType, 2, defaultCropOriginOffset);
  writeEntry(50720, rationalType, 2, defaultCropSizeOffset);
  writeEntry(50721, signedRationalType, 9, colorMatrixOffset);
  writeEntry(50729, rationalType, 2, asShotWhiteXyOffset);
  writeEntry(50778, shortType, 1, _d65ExifLightSource);
  writeEntry(50879, shortType, 1, 0); // ColorimetricReference = scene-referred
  writeEntry(50829, longType, 4, activeAreaDataOffset);
  writeEntry(51110, longType, 1, 1);

  data.setUint64(
    entryOffset,
    thumbnailIfdOffset ?? 0,
    Endian.little,
  );

  header.setRange(
    softwareOffset,
    softwareOffset + softwareBytes.length,
    softwareBytes,
  );
  header.setRange(modelOffset, modelOffset + modelBytes.length, modelBytes);

  const int matrixDenominator = 100000000;
  for (int index = 0; index < 9; index++) {
    final int numerator = (colorMatrix1[index] * matrixDenominator).round();
    if (numerator < -0x80000000 || numerator > 0x7fffffff) {
      throw InvalidLinearDngInput('ColorMatrix1 rational overflow.');
    }
    final int offset = colorMatrixOffset + index * 8;
    data.setInt32(offset, numerator, Endian.little);
    data.setInt32(offset + 4, matrixDenominator, Endian.little);
  }
  // Stored samples are already white-balanced scene-linear sRGB/D65.
  // ColorimetricReference=0 keeps the DNG scene-referred; AsShotWhiteXY=D65
  // records the neutral already baked into these synthetic camera coordinates.
  data.setUint32(asShotWhiteXyOffset, 3127, Endian.little);
  data.setUint32(asShotWhiteXyOffset + 4, 10000, Endian.little);
  data.setUint32(asShotWhiteXyOffset + 8, 3290, Endian.little);
  data.setUint32(asShotWhiteXyOffset + 12, 10000, Endian.little);
  for (int i = 0; i < 2; i++) {
    final int originOffset = defaultCropOriginOffset + i * 8;
    data.setUint32(originOffset, 0, Endian.little);
    data.setUint32(originOffset + 4, 1, Endian.little);
  }
  data.setUint32(defaultCropSizeOffset, width, Endian.little);
  data.setUint32(defaultCropSizeOffset + 4, 1, Endian.little);
  data.setUint32(defaultCropSizeOffset + 8, height, Endian.little);
  data.setUint32(defaultCropSizeOffset + 12, 1, Endian.little);
  data.setUint32(activeAreaDataOffset, 0, Endian.little);
  data.setUint32(activeAreaDataOffset + 4, 0, Endian.little);
  data.setUint32(activeAreaDataOffset + 8, height, Endian.little);
  data.setUint32(activeAreaDataOffset + 12, width, Endian.little);
  data.setInt32(baselineExposureOffset, baselineExposureEv, Endian.little);
  data.setInt32(baselineExposureOffset + 4, 1, Endian.little);
  if (stripCount > 1) {
    for (int index = 0; index < stripCount; index++) {
      data.setUint64(
        stripOffsetsArrayOffset + index * 8,
        stripOffsets[index],
        Endian.little,
      );
      data.setUint64(
        stripByteCountsArrayOffset + index * 8,
        stripByteCounts[index],
        Endian.little,
      );
    }
  }

  if (subIfdOffsetsArrayOffset != null) {
    int offset = subIfdOffsetsArrayOffset;
    if (thumbnailIfdOffset != null) {
      data.setUint64(offset, thumbnailIfdOffset, Endian.little);
      offset += 8;
    }
    if (transparencyIfdOffset != null) {
      data.setUint64(offset, transparencyIfdOffset, Endian.little);
    }
  }

  if (transparencyIfdOffset != null && transparencyMaskDataOffset != null) {
    final _TransparencyMaskDirectory directory =
        _buildTransparencyMaskDirectory(
      width: width,
      height: height,
      ifdOffset: transparencyIfdOffset,
      maskDataOffset: transparencyMaskDataOffset,
      bigTiff: true,
    );
    header.setRange(
      transparencyIfdOffset,
      transparencyIfdOffset + directory.directoryBytes.length,
      directory.directoryBytes,
    );
  }

  if (thumbnail != null &&
      thumbnailIfdOffset != null &&
      thumbnailDataOffset != null) {
    _writeBigThumbnail(
      header: header,
      thumbnail: thumbnail,
      ifdOffset: thumbnailIfdOffset,
      dataOffset: thumbnailDataOffset,
    );
  }

  return LinearDngHeader(
    bytes: header,
    pixelDataOffset: pixelDataOffset,
    stripOffsets: List<int>.unmodifiable(stripOffsets),
    stripByteCounts: List<int>.unmodifiable(stripByteCounts),
    imageDataEndOffset: nextOffset,
    transparencyMaskDataOffset: transparencyMaskDataOffset,
    thumbnailIfdOffset: thumbnailIfdOffset,
    thumbnailDataOffset: thumbnailDataOffset,
    isBigTiff: true,
  );
}

final class _TransparencyMaskDirectory {
  const _TransparencyMaskDirectory({
    required this.directoryBytes,
  });

  final Uint8List directoryBytes;
}

_TransparencyMaskDirectory _buildTransparencyMaskDirectory({
  required int width,
  required int height,
  required int ifdOffset,
  required int maskDataOffset,
  required bool bigTiff,
}) {
  if (width <= 0 || height <= 0) {
    throw InvalidLinearDngInput(
        'Transparency-mask dimensions must be positive.');
  }
  final int byteCount = width * height;
  if (!bigTiff) {
    _checkedUint32(ifdOffset, 'transparencyMaskIfdOffset');
    _checkedUint32(byteCount, 'transparencyMaskByteCount');
    const int entryCount = _transparencyMaskIfdEntryCount;
    const int ifdLength = 2 + entryCount * 12 + 4;
    final int minimumMaskDataOffset = _checkedUint32(
      _align4(ifdOffset + ifdLength),
      'minimumTransparencyMaskDataOffset',
    );
    if (maskDataOffset < minimumMaskDataOffset) {
      throw InvalidLinearDngInput(
        'Transparency-mask data overlaps its IFD.',
      );
    }
    _checkedUint32(maskDataOffset, 'transparencyMaskDataOffset');
    _checkedUint32(maskDataOffset + byteCount, 'DNG file size');

    final Uint8List bytes = Uint8List(minimumMaskDataOffset - ifdOffset);
    final ByteData data = ByteData.sublistView(bytes);
    data.setUint16(0, entryCount, Endian.little);
    int e = 2;
    void entry(int tag, int type, int count, int value) {
      data.setUint16(e, tag, Endian.little);
      data.setUint16(e + 2, type, Endian.little);
      data.setUint32(e + 4, count, Endian.little);
      data.setUint32(e + 8, value, Endian.little);
      e += 12;
    }

    const int shortType = 3;
    const int longType = 4;
    entry(254, longType, 1, 4); // NewSubFileType = TransparencyMask
    entry(256, longType, 1, width);
    entry(257, longType, 1, height);
    entry(258, shortType, 1, 8);
    entry(259, shortType, 1, 1); // uncompressed
    entry(262, shortType, 1, 4); // PhotometricInterpretation = TransparencyMask
    entry(273, longType, 1, maskDataOffset);
    entry(277, shortType, 1, 1);
    entry(278, longType, 1, height);
    entry(279, longType, 1, byteCount);
    data.setUint32(e, 0, Endian.little);
    return _TransparencyMaskDirectory(
      directoryBytes: bytes,
    );
  }

  const int entryCount = _transparencyMaskIfdEntryCount;
  const int ifdLength = 8 + entryCount * 20 + 8;
  final int minimumMaskDataOffset = _align8(ifdOffset + ifdLength);
  if (maskDataOffset < minimumMaskDataOffset) {
    throw InvalidLinearDngInput(
      'Transparency-mask data overlaps its IFD.',
    );
  }
  final Uint8List bytes = Uint8List(minimumMaskDataOffset - ifdOffset);
  final ByteData data = ByteData.sublistView(bytes);
  data.setUint64(0, entryCount, Endian.little);
  int e = 8;
  void entry(int tag, int type, int count, int value) {
    data.setUint16(e, tag, Endian.little);
    data.setUint16(e + 2, type, Endian.little);
    data.setUint64(e + 4, count, Endian.little);
    data.setUint64(e + 12, value, Endian.little);
    e += 20;
  }

  const int shortType = 3;
  const int longType = 4;
  const int long8Type = 16;
  entry(254, longType, 1, 4);
  entry(256, longType, 1, width);
  entry(257, longType, 1, height);
  entry(258, shortType, 1, 8);
  entry(259, shortType, 1, 1);
  entry(262, shortType, 1, 4);
  entry(273, long8Type, 1, maskDataOffset);
  entry(277, shortType, 1, 1);
  entry(278, longType, 1, height);
  entry(279, long8Type, 1, byteCount);
  data.setUint64(e, 0, Endian.little);
  return _TransparencyMaskDirectory(
    directoryBytes: bytes,
  );
}

final class _LinearDngPreflight {
  const _LinearDngPreflight({
    required this.headroomEv,
    required this.thumbnail,
  });

  final int headroomEv;
  final LinearDngThumbnail thumbnail;
}

const int _embeddedThumbnailMaximumDimension = 256;
const double _embeddedThumbnailExposurePercentile = 99.0 / 100.0;
const int _linearDngDefaultRenderBaselineExposureEv = 0 * 1;

int _encodeSrgb8(double linear) {
  final double bounded = linear.clamp(0.0, 1.0).toDouble();
  final double encoded = bounded <= 0.0031308
      ? 12.92 * bounded
      : 1.055 * math.pow(bounded, 1.0 / 2.4) - 0.055;
  return (encoded * 255.0).round().clamp(0, 255).toInt();
}

/// Performs the two Linear-DNG preflight tasks that need source pixels in one
/// sequential store pass:
///
///  * determine lossless power-of-two highlight placement, and
///  * collect the <=256 px embedded thumbnail sample.
///
/// Older code scanned the entire tile store for headroom and then issued up to
/// 256 additional full-width one-row reads for the thumbnail. On a 24 MP RAW
/// stack that needlessly repeated file-backed raster I/O. This fused pass keeps
/// exactly the same transform, headroom rule, nearest-neighbour thumbnail
/// coordinates and 99th-percentile thumbnail exposure while reading every
/// source strip only once.
Future<_LinearDngPreflight> _analyzeLinearDngForExport({
  required LinearRgbTileStore tileStore,
  required LinearRgbColorTransform inputToLinearSrgb,
  required int rowsPerStrip,
  bool Function()? isCancelled,
}) async {
  final double scale = math.min(
    1.0,
    _embeddedThumbnailMaximumDimension /
        math.max(tileStore.width, tileStore.height),
  );
  final int thumbnailWidth = math.max(1, (tileStore.width * scale).round());
  final int thumbnailHeight = math.max(1, (tileStore.height * scale).round());
  final Float32List thumbnailLinearRgb =
      Float32List(thumbnailWidth * thumbnailHeight * 3);
  final Float32List thumbnailLuminance =
      Float32List(thumbnailWidth * thumbnailHeight);

  final List<int> sourceXForThumbnailX = List<int>.generate(
    thumbnailWidth,
    (int x) => (((x + 0.5) * tileStore.width) / thumbnailWidth)
        .floor()
        .clamp(0, tileStore.width - 1)
        .toInt(),
    growable: false,
  );
  final Map<int, List<int>> thumbnailRowsBySourceY = <int, List<int>>{};
  for (int y = 0; y < thumbnailHeight; y++) {
    final int sourceY = (((y + 0.5) * tileStore.height) / thumbnailHeight)
        .floor()
        .clamp(0, tileStore.height - 1)
        .toInt();
    (thumbnailRowsBySourceY[sourceY] ??= <int>[]).add(y);
  }

  double maximum = 0.0;
  double maximumLuminance = 0.0;
  final Float64List transformed = Float64List(3);
  for (int startRow = 0;
      startRow < tileStore.height;
      startRow += rowsPerStrip) {
    if (isCancelled?.call() ?? false) {
      throw const LinearDngExportCancelled();
    }
    final int rowCount =
        (tileStore.height - startRow).clamp(0, rowsPerStrip).toInt();
    final tile = await tileStore.readRegion(
      x: 0,
      y: startRow,
      width: tileStore.width,
      height: rowCount,
    );

    final int pixelCount = tile.interleavedRgb.length ~/ 3;
    for (int pixel = 0; pixel < pixelCount; pixel++) {
      if ((pixel & 0x3ffff) == 0 && (isCancelled?.call() ?? false)) {
        throw const LinearDngExportCancelled();
      }
      final int index = pixel * 3;
      final double r = tile.interleavedRgb[index];
      final double g = tile.interleavedRgb[index + 1];
      final double b = tile.interleavedRgb[index + 2];
      if (!r.isFinite || !g.isFinite || !b.isFinite) {
        throw InvalidLinearDngInput(
          'Linear RGB input contains a non-finite sample.',
        );
      }
      inputToLinearSrgb.transformPixel(r, g, b, transformed);
      for (int channel = 0; channel < 3; channel++) {
        final double value = transformed[channel];
        if (!value.isFinite || value.abs() > 3.4028234663852886e38) {
          throw InvalidLinearDngInput(
            'Linear DNG sample exceeds finite Float32 range.',
          );
        }
        if (value > maximum) maximum = value;
      }
    }

    // Thumbnail samples are sparse (<= 256x256). Reuse this already-read
    // strip rather than issuing a second full-width read for each thumbnail
    // row. Transform only the selected sample points again; this is bounded to
    // 65,536 pixels and avoids another full-raster I/O pass.
    for (int localY = 0; localY < rowCount; localY++) {
      final int sourceY = startRow + localY;
      final List<int>? thumbnailRows = thumbnailRowsBySourceY[sourceY];
      if (thumbnailRows == null) continue;
      for (final int thumbnailY in thumbnailRows) {
        if (isCancelled?.call() ?? false) {
          throw const LinearDngExportCancelled();
        }
        for (int thumbnailX = 0; thumbnailX < thumbnailWidth; thumbnailX++) {
          final int sourceX = sourceXForThumbnailX[thumbnailX];
          final int source = (localY * tileStore.width + sourceX) * 3;
          inputToLinearSrgb.transformPixel(
            tile.interleavedRgb[source],
            tile.interleavedRgb[source + 1],
            tile.interleavedRgb[source + 2],
            transformed,
          );
          final int destination =
              (thumbnailY * thumbnailWidth + thumbnailX) * 3;
          for (int channel = 0; channel < 3; channel++) {
            final double value = transformed[channel];
            if (!value.isFinite || value.abs() > 3.4028234663852886e38) {
              throw InvalidLinearDngInput(
                'Linear DNG sample exceeds finite Float32 range.',
              );
            }
            thumbnailLinearRgb[destination + channel] =
                value < 0.0 ? 0.0 : value;
          }
          final double luminance = 0.2126 * thumbnailLinearRgb[destination] +
              0.7152 * thumbnailLinearRgb[destination + 1] +
              0.0722 * thumbnailLinearRgb[destination + 2];
          thumbnailLuminance[thumbnailY * thumbnailWidth + thumbnailX] =
              luminance;
          if (luminance > maximumLuminance) maximumLuminance = luminance;
        }
      }
    }
  }

  final int headroomEv;
  if (maximum <= 1.0) {
    headroomEv = 0;
  } else {
    final int ev = (math.log(maximum) / math.ln2).ceil();
    if (ev < 0 || ev > 128) {
      throw InvalidLinearDngInput(
        'Linear DNG highlight headroom exceeds supported EV range.',
      );
    }
    headroomEv = ev;
  }

  if (isCancelled?.call() ?? false) {
    throw const LinearDngExportCancelled();
  }
  thumbnailLuminance.sort();
  final int percentileIndex =
      ((thumbnailLuminance.length - 1) * _embeddedThumbnailExposurePercentile)
          .floor();
  final double percentile = thumbnailLuminance[percentileIndex];
  final double reference = percentile > 0.0 ? percentile : maximumLuminance;
  final double exposure = reference > 0.0 ? 0.9 / reference : 1.0;
  final Uint8List thumbnailRgb8 = Uint8List(thumbnailLinearRgb.length);
  for (int index = 0; index < thumbnailLinearRgb.length; index++) {
    thumbnailRgb8[index] = _encodeSrgb8(thumbnailLinearRgb[index] * exposure);
  }

  return _LinearDngPreflight(
    headroomEv: headroomEv,
    thumbnail: LinearDngThumbnail(
      width: thumbnailWidth,
      height: thumbnailHeight,
      interleavedSrgb8: thumbnailRgb8,
    ),
  );
}

/// Writes a 32-bit floating-point Linear DNG from [tileStore].
///
/// [inputToLinearSrgb] must describe only a linear color-space conversion.
/// Exposure compensation, DNG profile LUTs, tone curves, local tone
/// adaptation and sRGB transfer encoding must not be baked before this stage.
Future<Uint8List> _encodeLinearDngFloat32Strip({
  required LinearRgbTileStore tileStore,
  required int startRow,
  required int rowCount,
  required LinearRgbColorTransform inputToLinearSrgb,
  required double headroomScale,
  bool Function()? isCancelled,
}) async {
  final tile = await tileStore.readRegion(
    x: 0,
    y: startRow,
    width: tileStore.width,
    height: rowCount,
  );
  final Uint8List encoded = Uint8List(tile.interleavedRgb.length * 4);
  final ByteData encodedData = ByteData.sublistView(encoded);
  final Float64List transformed = Float64List(3);
  for (int index = 0; index < tile.interleavedRgb.length; index += 3) {
    if (((index ~/ 3) & 0x3ffff) == 0 && (isCancelled?.call() ?? false)) {
      throw const LinearDngExportCancelled();
    }
    final double r = tile.interleavedRgb[index];
    final double g = tile.interleavedRgb[index + 1];
    final double b = tile.interleavedRgb[index + 2];
    if (!r.isFinite || !g.isFinite || !b.isFinite) {
      throw InvalidLinearDngInput(
        'Linear RGB input contains a non-finite sample.',
      );
    }
    inputToLinearSrgb.transformPixel(r, g, b, transformed);
    for (int channel = 0; channel < 3; channel++) {
      final double value = transformed[channel];
      if (!value.isFinite || value.abs() > 3.4028234663852886e38) {
        throw InvalidLinearDngInput(
          'Linear DNG sample exceeds finite Float32 range.',
        );
      }
      encodedData.setFloat32(
        (index + channel) * 4,
        value / headroomScale,
        Endian.little,
      );
    }
  }
  return encoded;
}

Future<File> exportTileStoreToLinearDng({
  required LinearRgbTileStore tileStore,
  required String outputPath,
  required LinearRgbColorTransform inputToLinearSrgb,
  int rowsPerStrip = 64,
  LinearDngContainer? container,
  Uint8List? transparencyMask,
  Uint8List? binaryValidityMask,
  LinearContributionTileStore? contributionStore,
  LinearDngTransparencyMaskSource? transparencyMaskSource,
  LinearDngCompression compression = LinearDngCompression.none,
  bool Function()? isCancelled,
}) async {
  final int maskSources = (transparencyMask != null ? 1 : 0) +
      (binaryValidityMask != null ? 1 : 0) +
      (contributionStore != null ? 1 : 0) +
      (transparencyMaskSource != null ? 1 : 0);
  if (maskSources > 1) {
    throw InvalidLinearDngInput(
      'Provide only one of transparencyMask, binaryValidityMask, contributionStore, or transparencyMaskSource.',
    );
  }
  if (contributionStore != null &&
      (contributionStore.width != tileStore.width ||
          contributionStore.height != tileStore.height)) {
    throw InvalidLinearDngInput(
      'Contribution-store dimensions do not match output dimensions.',
    );
  }
  if (transparencyMaskSource != null &&
      (transparencyMaskSource.width != tileStore.width ||
          transparencyMaskSource.height != tileStore.height)) {
    throw InvalidLinearDngInput(
      'Transparency-mask source dimensions do not match output dimensions.',
    );
  }
  final bool includeTransparencyMask = maskSources != 0;
  final LinearDngContainer selectedContainer = container ??
      recommendedLinearDngContainer(
        width: tileStore.width,
        height: tileStore.height,
        includeTransparencyMask: includeTransparencyMask,
      );
  // DNG readers normalize Float LinearRaw against WhiteLevel=1.0 and clip
  // linear-reference values to that range. Preserve stack highlight headroom by
  // applying an exact power-of-two placement before storage. Stack tiles can be
  // in calibrated raw-domain numeric units, so this placement is normalization,
  // not capture exposure. Advertising its inverse as BaselineExposure made
  // Adobe apply a +13 EV display gain to a real Sony stack and render it all
  // white. Keep the default-render exposure neutral while preserving relative
  // scene-linear values and every recoverable highlight in the stored raster.
  final _LinearDngPreflight preflight = await _analyzeLinearDngForExport(
    tileStore: tileStore,
    inputToLinearSrgb: inputToLinearSrgb,
    rowsPerStrip: rowsPerStrip,
    isCancelled: isCancelled,
  );
  final int headroomEv = preflight.headroomEv;
  final LinearDngThumbnail thumbnail = preflight.thumbnail;
  final double headroomScale = math.pow(2.0, headroomEv).toDouble();
  Directory? compressionDirectory;
  File? compressedPixels;
  List<int>? compressedStripByteCounts;
  if (compression == LinearDngCompression.deflate) {
    if (selectedContainer == LinearDngContainer.bigTiff) {
      throw InvalidLinearDngInput(
        'Deflate output is currently limited to classic DNG-sized images.',
      );
    }
    compressionDirectory = await Directory.systemTemp.createTemp(
      'mobile-stack-dng-deflate-',
    );
    compressedPixels = File(
      '${compressionDirectory.path}${Platform.pathSeparator}pixels.deflate',
    );
    final RandomAccessFile compressedOutput =
        await compressedPixels.open(mode: FileMode.write);
    compressedStripByteCounts = <int>[];
    try {
      try {
        final int stripCount =
            (tileStore.height + rowsPerStrip - 1) ~/ rowsPerStrip;
        final ZLibEncoder encoder = ZLibEncoder(level: 6);
        for (int strip = 0; strip < stripCount; strip++) {
          if (isCancelled?.call() ?? false) {
            throw const LinearDngExportCancelled();
          }
          final int startRow = strip * rowsPerStrip;
          final int rowCount =
              (tileStore.height - startRow).clamp(0, rowsPerStrip).toInt();
          final Uint8List raw = await _encodeLinearDngFloat32Strip(
            tileStore: tileStore,
            startRow: startRow,
            rowCount: rowCount,
            inputToLinearSrgb: inputToLinearSrgb,
            headroomScale: headroomScale,
            isCancelled: isCancelled,
          );
          final List<int> deflated = encoder.convert(raw);
          await compressedOutput.writeFrom(deflated);
          compressedStripByteCounts.add(deflated.length);
        }
      } finally {
        await compressedOutput.close();
      }
    } catch (_) {
      try {
        if (await compressionDirectory.exists()) {
          await compressionDirectory.delete(recursive: true);
        }
      } on FileSystemException {
        // Best-effort cleanup before propagating preparation failure.
      }
      rethrow;
    }
  }
  final LinearDngHeader header = switch (selectedContainer) {
    LinearDngContainer.classic => encodeLinearDngFloat32Header(
        width: tileStore.width,
        height: tileStore.height,
        rowsPerStrip: rowsPerStrip,
        includeTransparencyMask: includeTransparencyMask,
        thumbnail: thumbnail,
        baselineExposureEv: _linearDngDefaultRenderBaselineExposureEv,
        compression: compression,
        encodedStripByteCounts: compressedStripByteCounts,
      ),
    LinearDngContainer.bigTiff => encodeBigLinearDngFloat32Header(
        width: tileStore.width,
        height: tileStore.height,
        rowsPerStrip: rowsPerStrip,
        includeTransparencyMask: includeTransparencyMask,
        thumbnail: thumbnail,
        baselineExposureEv: _linearDngDefaultRenderBaselineExposureEv,
      ),
  };
  if (transparencyMask != null) {
    if (transparencyMask.length != tileStore.width * tileStore.height) {
      throw InvalidLinearDngInput(
        'Transparency-mask sample count does not match output dimensions.',
      );
    }
    if (transparencyMask.any((int value) => value != 0 && value != 255)) {
      throw InvalidLinearDngInput(
        'Transparency mask must be binary validity data (0 or 255 only).',
      );
    }
  }
  if (binaryValidityMask != null) {
    if (binaryValidityMask.length != tileStore.width * tileStore.height) {
      throw InvalidLinearDngInput(
        'Binary validity-mask sample count does not match output dimensions.',
      );
    }
    if (binaryValidityMask.any((int value) => value != 0 && value != 1)) {
      throw InvalidLinearDngInput(
        'Binary validity mask must contain only 0 or 1.',
      );
    }
  }

  final File file = File(outputPath);
  IOSink? sink;
  try {
    sink = file.openWrite(mode: FileMode.write);
    sink.add(header.bytes);

    if (compressedPixels != null) {
      // addStream applies backpressure. A plain add() loop can queue the
      // entire hundreds-of-megabytes payload behind IOSink on Android.
      await sink.addStream(compressedPixels.openRead().map((List<int> chunk) {
        if (isCancelled?.call() ?? false) {
          throw const LinearDngExportCancelled();
        }
        return chunk;
      }));
    } else {
      for (int strip = 0; strip < header.stripOffsets.length; strip++) {
        if (isCancelled?.call() ?? false) {
          throw const LinearDngExportCancelled();
        }
        final int startRow = strip * rowsPerStrip;
        final int rowCount =
            (tileStore.height - startRow).clamp(0, rowsPerStrip).toInt();
        final Uint8List encodedStrip = await _encodeLinearDngFloat32Strip(
          tileStore: tileStore,
          startRow: startRow,
          rowCount: rowCount,
          inputToLinearSrgb: inputToLinearSrgb,
          headroomScale: headroomScale,
          isCancelled: isCancelled,
        );
        sink.add(encodedStrip);
        // Bound pending output to one strip. This is deliberately awaited
        // before encodedStrip goes out of scope and the next strip is built.
        await sink.flush();
      }
    }
    if (includeTransparencyMask) {
      final int? maskDataOffset = header.transparencyMaskDataOffset;
      if (maskDataOffset == null) {
        throw StateError(
          'Transparency mask requested without a reserved data offset.',
        );
      }
      final int padding = maskDataOffset - header.imageDataEndOffset;
      if (padding > 0) sink.add(Uint8List(padding));
      if (transparencyMask != null) {
        sink.add(transparencyMask);
        await sink.flush();
      } else if (binaryValidityMask != null) {
        final Uint8List source = binaryValidityMask;
        const int maskChunkBytes = 262144;
        final Uint8List encodedMask = Uint8List(maskChunkBytes);
        for (int offset = 0; offset < source.length; offset += maskChunkBytes) {
          if (isCancelled?.call() ?? false) {
            throw const LinearDngExportCancelled();
          }
          final int count = math.min(maskChunkBytes, source.length - offset);
          for (int index = 0; index < count; index++) {
            encodedMask[index] = source[offset + index] == 0 ? 0 : 255;
          }
          sink.add(Uint8List.sublistView(encodedMask, 0, count));
          // IOSink.add() does not provide per-chunk completion. Flush before
          // reusing encodedMask so queued output can never observe mutated bytes.
          await sink.flush();
        }
      } else if (contributionStore != null) {
        final LinearContributionTileStore source = contributionStore;
        const int rowsPerMaskRead = 128;
        for (int startY = 0;
            startY < source.height;
            startY += rowsPerMaskRead) {
          if (isCancelled?.call() ?? false) {
            throw const LinearDngExportCancelled();
          }
          final int rows = math.min(rowsPerMaskRead, source.height - startY);
          final contributionTile = await source.readRegion(
            x: 0,
            y: startY,
            width: source.width,
            height: rows,
          );
          final int pixels = source.width * rows;
          final Uint8List encodedMask = Uint8List(pixels);
          for (int pixel = 0; pixel < pixels; pixel++) {
            if ((pixel & 0x3ffff) == 0 && (isCancelled?.call() ?? false)) {
              throw const LinearDngExportCancelled();
            }
            final int base = pixel * 3;
            encodedMask[pixel] = contributionTile.interleavedCounts[base] > 0 &&
                    contributionTile.interleavedCounts[base + 1] > 0 &&
                    contributionTile.interleavedCounts[base + 2] > 0
                ? 255
                : 0;
          }
          sink.add(encodedMask);
          await sink.flush();
        }
      } else {
        final LinearDngTransparencyMaskSource source = transparencyMaskSource!;
        const int rowsPerMaskRead = 128;
        for (int startY = 0;
            startY < source.height;
            startY += rowsPerMaskRead) {
          if (isCancelled?.call() ?? false) {
            throw const LinearDngExportCancelled();
          }
          final int rows = math.min(rowsPerMaskRead, source.height - startY);
          final Uint8List encodedMask = await source.readRows(
            startY: startY,
            rowCount: rows,
          );
          if (encodedMask.length != source.width * rows) {
            throw InvalidLinearDngInput(
              'Transparency-mask source returned an unexpected sample count.',
            );
          }
          for (int index = 0; index < encodedMask.length; index++) {
            if ((index & 0x3ffff) == 0 && (isCancelled?.call() ?? false)) {
              throw const LinearDngExportCancelled();
            }
            final int value = encodedMask[index];
            if (value != 0 && value != 255) {
              throw InvalidLinearDngInput(
                'Transparency-mask source must return only 0 or 255.',
              );
            }
          }
          sink.add(encodedMask);
          await sink.flush();
        }
      }
    }
    await sink.flush();
    await sink.close();
    sink = null;
    return file;
  } catch (_) {
    if (sink != null) {
      try {
        await sink.close();
      } catch (_) {
        // Best-effort close before deleting a partial DNG.
      }
    }
    try {
      if (await file.exists()) await file.delete();
    } on FileSystemException {
      // Best-effort partial-file cleanup.
    }
    rethrow;
  } finally {
    if (compressionDirectory != null) {
      try {
        if (await compressionDirectory.exists()) {
          await compressionDirectory.delete(recursive: true);
        }
      } on FileSystemException {
        // Best-effort cleanup of the lossless-compression staging file.
      }
    }
  }
}
