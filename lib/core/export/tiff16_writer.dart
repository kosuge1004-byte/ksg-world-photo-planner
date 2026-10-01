import 'dart:convert';
import 'dart:typed_data';

// Frozen standard sRGB profile generated once with Pillow ImageCms/Little CMS.
// The profile's embedded copyright text is "No copyright, use freely".
// SHA-256: 282FE7E91F6543B75C700B938F9A2531BB59F6A4D28130E0769604FEB6225AAB
final Uint8List _standardSrgbIccProfile = base64Decode(
  'AAACTGxjbXMEQAAAbW50clJHQiBYWVogB+oACAAJABcAHQAXYWNzcE1TRlQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA2Y3BydAAAAUAAAABMd3RwdAAAAYwAAAAUY2hhZAAAAaAAAAAsclhZWgAAAcwAAAAUYlhZWgAAAeAAAAAUZ1hZWgAAAfQAAAAUclRSQwAAAggAAAAgZ1RSQwAAAggAAAAgYlRSQwAAAggAAAAgY2hybQAAAigAAAAkbWx1YwAAAAAAAAABAAAADGVuVVMAAAAaAAAAHABzAFIARwBCACAAYgB1AGkAbAB0AC0AaQBuAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAADAAAAAcAE4AbwAgAGMAbwBwAHkAcgBpAGcAaAB0ACwAIAB1AHMAZQAgAGYAcgBlAGUAbAB5WFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDEIAAAXe///zJQAAB5MAAP2Q///7of///aIAAAPcAADAblhZWiAAAAAAAABvoAAAOPUAAAOQWFlaIAAAAAAAACSfAAAPhAAAtsNYWVogAAAAAAAAYpcAALeHAAAY2XBhcmEAAAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbY2hybQAAAAAAAwAAAACj1wAAVHsAAEzNAACZmgAAJmYAAA9c',
);

Uint8List get standardSrgbIccProfileBytes =>
    Uint8List.fromList(_standardSrgbIccProfile);

const int classicTiffMaximumOffset = 0xffffffff;

int classicTiff16PixelDataOffsetFor({
  required int height,
  int rowsPerStrip = 128,
}) {
  if (height <= 0 || rowsPerStrip <= 0) {
    throw InvalidTiffInput('height and rowsPerStrip must be positive.');
  }
  const int entryCount = 13;
  const int ifdOffset = 8;
  const int ifdByteLength = 2 + entryCount * 12 + 4;
  final int stripCount = (height + rowsPerStrip - 1) ~/ rowsPerStrip;
  return ifdOffset +
      ifdByteLength +
      6 +
      (stripCount > 1 ? stripCount * 8 : 0) +
      _standardSrgbIccProfile.length;
}

class InvalidTiffInput extends ArgumentError {
  InvalidTiffInput(super.message);
}

enum Tiff16Compression {
  none(1),
  deflate(8);

  const Tiff16Compression(this.tagValue);
  final int tagValue;
}

enum Tiff16Predictor {
  none(1),
  horizontalDifferencing(2);

  const Tiff16Predictor(this.tagValue);
  final int tagValue;
}

final class Tiff16Header {
  const Tiff16Header({
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

/// Builds the complete metadata prefix for a classic little-endian TIFF.
/// Pixel data follows immediately at [Tiff16Header.pixelDataOffset] as
/// interleaved, top-to-bottom unsigned 16-bit R, G, B samples.
Tiff16Header encodeTiff16Header({
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
  if (width > classicTiffMaximumOffset || height > classicTiffMaximumOffset) {
    throw InvalidTiffInput('Classic TIFF dimensions must fit in uint32.');
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
  const int ifdOffset = 8;
  const int ifdByteLength = 2 + entryCount * 12 + 4;
  final int bitsPerSampleOffset = ifdOffset + ifdByteLength;
  final int stripOffsetsArrayOffset = bitsPerSampleOffset + 6;
  final int stripByteCountsArrayOffset =
      stripOffsetsArrayOffset + (stripCount > 1 ? stripCount * 4 : 0);
  final int iccProfileOffset =
      stripByteCountsArrayOffset + (stripCount > 1 ? stripCount * 4 : 0);
  final int pixelDataOffset = iccProfileOffset + _standardSrgbIccProfile.length;
  if (pixelDataOffset > classicTiffMaximumOffset) {
    throw InvalidTiffInput(
      'Classic TIFF metadata would exceed the 4 GiB offset limit.',
    );
  }

  final List<int> stripByteCounts = stripByteCountsOverride == null
      ? <int>[]
      : List<int>.from(stripByteCountsOverride);
  final List<int> stripOffsets = stripOffsetsOverride == null
      ? <int>[]
      : List<int>.from(stripOffsetsOverride);
  int nextOffset = pixelDataOffset;
  if (deferredStrips) {
    stripOffsets.addAll(List<int>.filled(stripCount, pixelDataOffset));
    stripByteCounts.addAll(List<int>.filled(stripCount, 0));
  } else if (stripOffsetsOverride == null) {
    for (int strip = 0; strip < stripCount; strip++) {
      final int startRow = strip * rowsPerStrip;
      final int rowCount = (height - startRow).clamp(0, rowsPerStrip).toInt();
      final int byteCount = width * rowCount * 6;
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
      validateClassicTiffWriteRange(offset: offset, byteCount: byteCount);
      if (offset + byteCount > nextOffset) nextOffset = offset + byteCount;
    }
  }
  if (nextOffset > classicTiffMaximumOffset) {
    throw InvalidTiffInput(
      'Classic TIFF output would exceed the 4 GiB offset limit.',
    );
  }

  final Uint8List header = Uint8List(pixelDataOffset);
  final ByteData data = ByteData.sublistView(header);
  header[0] = 0x49;
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

  const int shortType = 3;
  const int longType = 4;
  writeEntry(256, longType, 1, width); // ImageWidth
  writeEntry(257, longType, 1, height); // ImageLength
  writeEntry(258, shortType, 3, bitsPerSampleOffset); // BitsPerSample
  writeEntry(259, shortType, 1, compression.tagValue);
  writeEntry(262, shortType, 1, 2); // PhotometricInterpretation = RGB
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
  writeEntry(317, shortType, 1, predictor.tagValue);
  writeEntry(
    34675,
    7, // UNDEFINED byte data
    _standardSrgbIccProfile.length,
    iccProfileOffset,
  ); // InterColorProfile
  data.setUint32(entryOffset, 0, Endian.little); // No next IFD.

  data.setUint16(bitsPerSampleOffset, 16, Endian.little);
  data.setUint16(bitsPerSampleOffset + 2, 16, Endian.little);
  data.setUint16(bitsPerSampleOffset + 4, 16, Endian.little);
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
  header.setRange(
    iccProfileOffset,
    iccProfileOffset + _standardSrgbIccProfile.length,
    _standardSrgbIccProfile,
  );
  return Tiff16Header(
    bytes: header,
    pixelDataOffset: pixelDataOffset,
    stripOffsets: List<int>.unmodifiable(stripOffsets),
    stripByteCounts: List<int>.unmodifiable(stripByteCounts),
  );
}

void validateClassicTiffWriteRange({
  required int offset,
  required int byteCount,
}) {
  if (offset < 0 || byteCount < 0) {
    throw InvalidTiffInput('TIFF offset and byte count must not be negative.');
  }
  if (offset > classicTiffMaximumOffset ||
      byteCount > classicTiffMaximumOffset - offset) {
    throw InvalidTiffInput(
      'Classic TIFF output would exceed the 4 GiB offset limit.',
    );
  }
}
