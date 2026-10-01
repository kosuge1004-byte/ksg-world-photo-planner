import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/tiff16_writer.dart';

void main() {
  test('single-strip header declares baseline 16-bit chunky RGB', () {
    final Tiff16Header header = encodeTiff16Header(
      width: 3,
      height: 2,
      rowsPerStrip: 128,
    );
    final ByteData data = ByteData.sublistView(header.bytes);
    expect(header.bytes.sublist(0, 2), <int>[0x49, 0x49]);
    expect(data.getUint16(2, Endian.little), 42);
    expect(data.getUint32(4, Endian.little), 8);
    expect(data.getUint16(8, Endian.little), 13);
    expect(header.stripOffsets, <int>[header.pixelDataOffset]);
    expect(header.stripByteCounts, <int>[3 * 2 * 6]);
    expect(
      classicTiff16PixelDataOffsetFor(height: 2),
      header.pixelDataOffset,
    );

    final Map<int, (int, int, int)> entries = <int, (int, int, int)>{};
    for (int index = 0; index < 13; index++) {
      final int offset = 10 + index * 12;
      entries[data.getUint16(offset, Endian.little)] = (
        data.getUint16(offset + 2, Endian.little),
        data.getUint32(offset + 4, Endian.little),
        data.getUint32(offset + 8, Endian.little),
      );
    }
    expect(entries[256], (4, 1, 3));
    expect(entries[257], (4, 1, 2));
    expect(entries[259], (3, 1, 1));
    expect(entries[262], (3, 1, 2));
    expect(entries[274], (3, 1, 1));
    expect(entries[277], (3, 1, 3));
    expect(entries[284], (3, 1, 1));
    expect(entries[317], (3, 1, 1));
    final (int, int, int) iccEntry = entries[34675]!;
    expect(iccEntry.$1, 7);
    expect(iccEntry.$2, 588);
    expect(
      header.bytes.sublist(iccEntry.$3, iccEntry.$3 + iccEntry.$2),
      standardSrgbIccProfileBytes,
    );
    final int bitsOffset = entries[258]!.$3;
    expect(
      <int>[
        data.getUint16(bitsOffset, Endian.little),
        data.getUint16(bitsOffset + 2, Endian.little),
        data.getUint16(bitsOffset + 4, Endian.little),
      ],
      <int>[16, 16, 16],
    );
  });

  test('multiple strips publish matching offsets and byte counts', () {
    final Tiff16Header header = encodeTiff16Header(
      width: 2,
      height: 5,
      rowsPerStrip: 2,
    );
    expect(header.stripByteCounts, <int>[24, 24, 12]);
    expect(header.stripOffsets[0], header.pixelDataOffset);
    expect(header.stripOffsets[1], header.pixelDataOffset + 24);
    expect(header.stripOffsets[2], header.pixelDataOffset + 48);
  });

  test('finalized Deflate header records compression and actual strips', () {
    final Tiff16Header uncompressedLayout = encodeTiff16Header(
      width: 2,
      height: 5,
      rowsPerStrip: 2,
    );
    final List<int> offsets = <int>[
      uncompressedLayout.pixelDataOffset,
      uncompressedLayout.pixelDataOffset + 10,
      uncompressedLayout.pixelDataOffset + 18,
    ];
    final Tiff16Header header = encodeTiff16Header(
      width: 2,
      height: 5,
      rowsPerStrip: 2,
      compression: Tiff16Compression.deflate,
      predictor: Tiff16Predictor.horizontalDifferencing,
      stripOffsetsOverride: offsets,
      stripByteCountsOverride: <int>[10, 8, 6],
    );
    final ByteData data = ByteData.sublistView(header.bytes);
    int compression = -1;
    int predictor = -1;
    for (int index = 0; index < 13; index++) {
      final int entry = 10 + index * 12;
      if (data.getUint16(entry, Endian.little) == 259) {
        compression = data.getUint16(entry + 8, Endian.little);
      }
      if (data.getUint16(entry, Endian.little) == 317) {
        predictor = data.getUint16(entry + 8, Endian.little);
      }
    }
    expect(compression, 8);
    expect(predictor, 2);
    expect(header.stripOffsets, offsets);
    expect(header.stripByteCounts, <int>[10, 8, 6]);
  });

  test('classic TIFF rejects output beyond its 4 GiB offset limit', () {
    expect(
      () => encodeTiff16Header(width: 100000, height: 100000),
      throwsA(isA<InvalidTiffInput>()),
    );
  });

  test('deferred Deflate strips allow a raw layout larger than 4 GiB', () {
    final Tiff16Header header = encodeTiff16Header(
      width: 100000,
      height: 10000,
      rowsPerStrip: 128,
      compression: Tiff16Compression.deflate,
      deferredStrips: true,
    );
    expect(100000 * 10000 * 6, greaterThan(classicTiffMaximumOffset));
    expect(header.stripOffsets, hasLength(79));
    expect(
      header.stripOffsets.every(
        (int offset) => offset == header.pixelDataOffset,
      ),
      isTrue,
    );
    expect(header.stripByteCounts.every((int count) => count == 0), isTrue);
    expect(header.bytes.length, header.pixelDataOffset);
  });

  test('deferred strips are only valid for unfinished Deflate headers', () {
    expect(
      () => encodeTiff16Header(
        width: 2,
        height: 2,
        deferredStrips: true,
      ),
      throwsA(isA<InvalidTiffInput>()),
    );
    expect(
      () => encodeTiff16Header(
        width: 2,
        height: 2,
        compression: Tiff16Compression.deflate,
        deferredStrips: true,
        stripOffsetsOverride: <int>[800],
        stripByteCountsOverride: <int>[10],
      ),
      throwsA(isA<InvalidTiffInput>()),
    );
  });

  test('classic TIFF write range accepts the boundary but not one byte more',
      () {
    expect(
      () => validateClassicTiffWriteRange(
        offset: classicTiffMaximumOffset - 10,
        byteCount: 10,
      ),
      returnsNormally,
    );
    expect(
      () => validateClassicTiffWriteRange(
        offset: classicTiffMaximumOffset - 10,
        byteCount: 11,
      ),
      throwsA(isA<InvalidTiffInput>()),
    );
    expect(
      () => validateClassicTiffWriteRange(offset: -1, byteCount: 1),
      throwsA(isA<InvalidTiffInput>()),
    );
  });

  test('horizontal predictor without Deflate is rejected', () {
    expect(
      () => encodeTiff16Header(
        width: 2,
        height: 2,
        predictor: Tiff16Predictor.horizontalDifferencing,
      ),
      throwsA(isA<InvalidTiffInput>()),
    );
  });
}
