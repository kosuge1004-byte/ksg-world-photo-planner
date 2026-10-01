import 'dart:typed_data';

import 'tiff16_writer.dart';

const int bigTiffMaximumDartOffset = 0x7fffffffffffffff;

final class BigTiff16Header {
  const BigTiff16Header({
    required this.bytes,
    required this.pixelDataOffset,
    required this.stripOffsets,
    required this.stripByteCounts,
  });

  final Uint8List bytes;
  final int pixelDataOffset;
  final List<int> stripOffsets;
  final List<int> stripByteCounts;
}

/// Builds a little-endian BigTIFF metadata prefix for unsigned 16-bit RGB.
/// BigTIFF uses 64-bit IFD counts, values, offsets, and LONG8 strip arrays.
BigTiff16Header encodeBigTiff16Header({
  required int width,
  required int height,
  int rowsPerStrip = 128,
  Tiff16Compression compression = Tiff16Compression.none,
  Tiff16Predictor predictor = Tiff16Predictor.none,
  List<int>? stripOffsetsOverride,
  List<int>? stripByteCountsOverride,
  bool deferredStrips = false,
}) {
  if (width <= 0 || height <= 0 || rowsPerStrip <= 0) {
    throw InvalidTiffInput('width, height and rowsPerStrip must be positive.');
  }
  if (width > bigTiffMaximumDartOffset || height > bigTiffMaximumDartOffset) {
    throw InvalidTiffInput('BigTIFF dimensions exceed Dart offset range.');
  }
  final int stripCount = (height + rowsPerStrip - 1) ~/ rowsPerStrip;
  if ((stripOffsetsOverride == null) != (stripByteCountsOverride == null)) {
    throw InvalidTiffInput(
      'strip offsets and byte counts must be supplied together.',
    );
  }
  if (stripOffsetsOverride != null &&
      (stripOffsetsOverride.length != stripCount ||
          stripByteCountsOverride!.length != stripCount)) {
    throw InvalidTiffInput('strip override count does not match the image.');
  }
  if (deferredStrips &&
      (compression != Tiff16Compression.deflate ||
          stripOffsetsOverride != null)) {
    throw InvalidTiffInput(
      'Deferred strips require Deflate compression without finalized strips.',
    );
  }
  if (compression == Tiff16Compression.deflate &&
      stripOffsetsOverride == null &&
      !deferredStrips) {
    throw InvalidTiffInput(
      'Deflate headers require finalized strip offsets and byte counts.',
    );
  }
  if (predictor == Tiff16Predictor.horizontalDifferencing &&
      compression != Tiff16Compression.deflate) {
    throw InvalidTiffInput(
      'Horizontal differencing requires Deflate compression.',
    );
  }

  const int entryCount = 13;
  const int ifdOffset = 16;
  const int ifdByteLength = 8 + entryCount * 20 + 8;
  int metadataCursor = _alignToEight(ifdOffset + ifdByteLength);
  final int stripOffsetsArrayOffset = stripCount > 1 ? metadataCursor : 0;
  if (stripCount > 1) metadataCursor += stripCount * 8;
  metadataCursor = _alignToEight(metadataCursor);
  final int stripByteCountsArrayOffset = stripCount > 1 ? metadataCursor : 0;
  if (stripCount > 1) metadataCursor += stripCount * 8;
  metadataCursor = _alignToEight(metadataCursor);
  final Uint8List iccProfile = standardSrgbIccProfileBytes;
  final int iccProfileOffset = metadataCursor;
  metadataCursor += iccProfile.length;
  final int pixelDataOffset = _alignToEight(metadataCursor);
  validateBigTiffWriteRange(offset: 0, byteCount: pixelDataOffset);

  final List<int> stripOffsets = stripOffsetsOverride == null
      ? <int>[]
      : List<int>.from(stripOffsetsOverride);
  final List<int> stripByteCounts = stripByteCountsOverride == null
      ? <int>[]
      : List<int>.from(stripByteCountsOverride);
  int nextOffset = pixelDataOffset;
  if (deferredStrips) {
    stripOffsets.addAll(List<int>.filled(stripCount, pixelDataOffset));
    stripByteCounts.addAll(List<int>.filled(stripCount, 0));
  } else if (stripOffsetsOverride == null) {
    for (int strip = 0; strip < stripCount; strip++) {
      final int startRow = strip * rowsPerStrip;
      final int rowCount = (height - startRow).clamp(0, rowsPerStrip).toInt();
      final int byteCount = width * rowCount * 6;
      validateBigTiffWriteRange(offset: nextOffset, byteCount: byteCount);
      stripOffsets.add(nextOffset);
      stripByteCounts.add(byteCount);
      nextOffset += byteCount;
    }
  } else {
    for (int index = 0; index < stripCount; index++) {
      final int offset = stripOffsets[index];
      final int byteCount = stripByteCounts[index];
      if (offset < pixelDataOffset) {
        throw InvalidTiffInput('Invalid finalized strip offset or byte count.');
      }
      validateBigTiffWriteRange(offset: offset, byteCount: byteCount);
      if (offset + byteCount > nextOffset) nextOffset = offset + byteCount;
    }
  }

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

  const int shortType = 3;
  const int long8Type = 16;
  writeEntry(256, long8Type, 1, width);
  writeEntry(257, long8Type, 1, height);
  writeEntry(258, shortType, 3, 16 | (16 << 16) | (16 << 32));
  writeEntry(259, shortType, 1, compression.tagValue);
  writeEntry(262, shortType, 1, 2);
  writeEntry(
    273,
    long8Type,
    stripCount,
    stripCount == 1 ? stripOffsets.single : stripOffsetsArrayOffset,
  );
  writeEntry(274, shortType, 1, 1);
  writeEntry(277, shortType, 1, 3);
  writeEntry(278, long8Type, 1, rowsPerStrip);
  writeEntry(
    279,
    long8Type,
    stripCount,
    stripCount == 1 ? stripByteCounts.single : stripByteCountsArrayOffset,
  );
  writeEntry(284, shortType, 1, 1);
  writeEntry(317, shortType, 1, predictor.tagValue);
  writeEntry(34675, 7, iccProfile.length, iccProfileOffset);
  data.setUint64(entryOffset, 0, Endian.little);

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
  header.setRange(
    iccProfileOffset,
    iccProfileOffset + iccProfile.length,
    iccProfile,
  );
  return BigTiff16Header(
    bytes: header,
    pixelDataOffset: pixelDataOffset,
    stripOffsets: List<int>.unmodifiable(stripOffsets),
    stripByteCounts: List<int>.unmodifiable(stripByteCounts),
  );
}

void validateBigTiffWriteRange({
  required int offset,
  required int byteCount,
}) {
  if (offset < 0 || byteCount < 0) {
    throw InvalidTiffInput(
        'BigTIFF offset and byte count must not be negative.');
  }
  if (offset > bigTiffMaximumDartOffset ||
      byteCount > bigTiffMaximumDartOffset - offset) {
    throw InvalidTiffInput('BigTIFF output exceeds Dart signed offset range.');
  }
}

int _alignToEight(int value) => (value + 7) & ~7;
