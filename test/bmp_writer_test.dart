import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/bmp_writer.dart';

/// Dart port of `tool/raw_samples/test/bmp_writer_reference.test.mjs`.

void main() {
  test('encodes a 1x1 red pixel to the exact expected byte sequence', () {
    const int width = 1;
    const int height = 1;
    final Uint8List rgb8 = Uint8List.fromList(<int>[255, 0, 0]);
    final Uint8List bmp = encodeBmp(width: width, height: height, rgb8: rgb8);

    final Uint8List expected = Uint8List.fromList(<int>[
      0x42, 0x4d, // 'B','M'
      58, 0, 0, 0, // fileSize = 58
      0, 0, // reserved1
      0, 0, // reserved2
      54, 0, 0, 0, // pixelDataOffset = 54
      40, 0, 0, 0, // DIB header size = 40
      1, 0, 0, 0, // width = 1
      1, 0, 0, 0, // height = 1
      1, 0, // planes = 1
      24, 0, // bits per pixel = 24
      0, 0, 0, 0, // compression = 0 (BI_RGB)
      4, 0, 0, 0, // image (pixel data) size = 4
      0x13, 0x0b, 0, 0, // horizontal resolution = 2835
      0x13, 0x0b, 0, 0, // vertical resolution = 2835
      0, 0, 0, 0, // colors used = 0
      0, 0, 0, 0, // important colors = 0
      0, 0, 255, 0, // pixel: B=0, G=0, R=255, padding=0
    ]);

    expect(bmp.length, expected.length);
    expect(bmp, orderedEquals(expected));
  });

  test(
    'total file size and pixel data offset are always 14 + 40 + '
    'pixelDataSize / 54',
    () {
      const int width = 5;
      const int height = 3;
      final Uint8List rgb8 = Uint8List(width * height * 3)
        ..fillRange(0, width * height * 3, 128);
      final Uint8List bmp = encodeBmp(
        width: width,
        height: height,
        rgb8: rgb8,
      );
      final ByteData view = ByteData.sublistView(bmp);
      final int fileSize = view.getUint32(2, Endian.little);
      final int pixelDataOffset = view.getUint32(10, Endian.little);
      expect(pixelDataOffset, 54);
      expect(fileSize, bmp.length);
      expect(fileSize, 54 + view.getUint32(34, Endian.little));
    },
  );

  test('row byte count is padded to a multiple of 4 bytes', () {
    final Map<int, int> widthToStride = <int, int>{1: 4, 4: 12, 5: 16, 2: 8};
    for (final MapEntry<int, int> entry in widthToStride.entries) {
      final int width = entry.key;
      final int expectedStride = entry.value;
      const int height = 2;
      final Uint8List rgb8 = Uint8List(width * height * 3)
        ..fillRange(0, width * height * 3, 1);
      final Uint8List bmp = encodeBmp(
        width: width,
        height: height,
        rgb8: rgb8,
      );
      final ByteData view = ByteData.sublistView(bmp);
      final int imageSize = view.getUint32(34, Endian.little);
      expect(
        imageSize,
        expectedStride * height,
        reason: 'width=$width: expected stride $expectedStride',
      );
    }
  });

  test(
    'rows are stored bottom-up (BMP convention) and channels are BGR',
    () {
      const int width = 1;
      const int height = 2;
      final Uint8List rgb8 = Uint8List.fromList(<int>[
        255, 0, 0, // row 0 (top): red
        0, 255, 0, // row 1 (bottom): green
      ]);
      final Uint8List bmp = encodeBmp(
        width: width,
        height: height,
        rgb8: rgb8,
      );
      const int strideBytes = 4;
      const int pixelDataOffset = 54;

      final Uint8List firstStoredRow = bmp.sublist(
        pixelDataOffset,
        pixelDataOffset + strideBytes,
      );
      final Uint8List secondStoredRow = bmp.sublist(
        pixelDataOffset + strideBytes,
        pixelDataOffset + strideBytes * 2,
      );
      expect(firstStoredRow.sublist(0, 3), orderedEquals(<int>[0, 255, 0]));
      expect(secondStoredRow.sublist(0, 3), orderedEquals(<int>[0, 0, 255]));
    },
  );

  test(
    'a larger synthetic gradient round-trips pixel-for-pixel through '
    'manual decoding',
    () {
      const int width = 17; // not a multiple of 4, exercises padding
      const int height = 11;
      final Uint8List rgb8 = Uint8List(width * height * 3);
      for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
          final int index = (y * width + x) * 3;
          rgb8[index] = (x * 13) % 256;
          rgb8[index + 1] = (y * 17) % 256;
          rgb8[index + 2] = (x + y * 3) % 256;
        }
      }
      final Uint8List bmp = encodeBmp(
        width: width,
        height: height,
        rgb8: rgb8,
      );
      final ByteData view = ByteData.sublistView(bmp);
      final int pixelDataOffset = view.getUint32(10, Endian.little);
      final int decodedWidth = view.getInt32(18, Endian.little);
      final int decodedHeight = view.getInt32(22, Endian.little);
      expect(decodedWidth, width);
      expect(decodedHeight, height);
      final int strideBytes = ((width * 3 + 3) ~/ 4) * 4;

      for (int y = 0; y < height; y++) {
        final int sourceRow = height - 1 - y;
        final int rowStart = pixelDataOffset + y * strideBytes;
        for (int x = 0; x < width; x++) {
          final int decodedIndex = rowStart + x * 3;
          final int originalIndex = (sourceRow * width + x) * 3;
          expect(bmp[decodedIndex], rgb8[originalIndex + 2]);
          expect(bmp[decodedIndex + 1], rgb8[originalIndex + 1]);
          expect(bmp[decodedIndex + 2], rgb8[originalIndex]);
        }
      }
    },
  );

  test('rejects non-positive dimensions', () {
    final Uint8List rgb8 = Uint8List(3);
    expect(
      () => encodeBmp(width: 0, height: 1, rgb8: rgb8),
      throwsA(isA<InvalidBmpInput>()),
    );
    expect(
      () => encodeBmp(width: 1, height: -1, rgb8: rgb8),
      throwsA(isA<InvalidBmpInput>()),
    );
  });

  test('rejects a mismatched rgb8 length', () {
    expect(
      () => encodeBmp(width: 2, height: 2, rgb8: Uint8List(10)),
      throwsA(isA<InvalidBmpInput>()),
    );
  });

  test('rejects dimensions beyond the conservative 32767 safety limit', () {
    expect(
      () => encodeBmp(
        width: 40000,
        height: 1,
        rgb8: Uint8List(40000 * 3),
      ),
      throwsA(isA<InvalidBmpInput>()),
    );
  });
}
