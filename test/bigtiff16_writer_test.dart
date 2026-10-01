import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/bigtiff16_writer.dart';
import 'package:mobile_stack/core/export/tiff16_writer.dart';

void main() {
  test('BigTIFF header declares 64-bit 16-bit chunky RGB metadata', () {
    final BigTiff16Header header = encodeBigTiff16Header(
      width: 3,
      height: 2,
    );
    final ByteData data = ByteData.sublistView(header.bytes);
    expect(header.bytes.sublist(0, 2), <int>[0x49, 0x49]);
    expect(data.getUint16(2, Endian.little), 43);
    expect(data.getUint16(4, Endian.little), 8);
    expect(data.getUint16(6, Endian.little), 0);
    expect(data.getUint64(8, Endian.little), 16);
    expect(data.getUint64(16, Endian.little), 13);
    expect(header.pixelDataOffset % 8, 0);
    expect(header.stripOffsets, <int>[header.pixelDataOffset]);
    expect(header.stripByteCounts, <int>[3 * 2 * 6]);

    final Map<int, (int, int, int)> entries = <int, (int, int, int)>{};
    for (int index = 0; index < 13; index++) {
      final int offset = 24 + index * 20;
      entries[data.getUint16(offset, Endian.little)] = (
        data.getUint16(offset + 2, Endian.little),
        data.getUint64(offset + 4, Endian.little),
        data.getUint64(offset + 12, Endian.little),
      );
    }
    expect(entries[256], (16, 1, 3));
    expect(entries[257], (16, 1, 2));
    expect(entries[258], (3, 3, 16 | (16 << 16) | (16 << 32)));
    expect(entries[259], (3, 1, 1));
    expect(entries[273], (16, 1, header.pixelDataOffset));
    expect(entries[278], (16, 1, 128));
    expect(entries[279], (16, 1, 36));
    expect(entries[317], (3, 1, 1));
    final (int, int, int) iccEntry = entries[34675]!;
    expect(iccEntry.$1, 7);
    expect(iccEntry.$2, 588);
    expect(
      header.bytes.sublist(iccEntry.$3, iccEntry.$3 + iccEntry.$2),
      standardSrgbIccProfileBytes,
    );
  });

  test('BigTIFF multiple strips use aligned LONG8 arrays', () {
    final BigTiff16Header header = encodeBigTiff16Header(
      width: 2,
      height: 5,
      rowsPerStrip: 2,
    );
    expect(header.stripByteCounts, <int>[24, 24, 12]);
    expect(header.stripOffsets[0], header.pixelDataOffset);
    expect(header.stripOffsets[1], header.pixelDataOffset + 24);
    expect(header.stripOffsets[2], header.pixelDataOffset + 48);
    expect(header.pixelDataOffset % 8, 0);
  });

  test('BigTIFF finalized Deflate and deferred strips are supported', () {
    final BigTiff16Header deferred = encodeBigTiff16Header(
      width: 100000,
      height: 10000,
      compression: Tiff16Compression.deflate,
      deferredStrips: true,
    );
    expect(deferred.stripOffsets, hasLength(79));
    expect(deferred.stripByteCounts.every((int count) => count == 0), isTrue);
    final List<int> offsets = <int>[
      deferred.pixelDataOffset,
      deferred.pixelDataOffset + 10,
    ];
    final BigTiff16Header finalized = encodeBigTiff16Header(
      width: 2,
      height: 3,
      rowsPerStrip: 2,
      compression: Tiff16Compression.deflate,
      predictor: Tiff16Predictor.horizontalDifferencing,
      stripOffsetsOverride: offsets,
      stripByteCountsOverride: <int>[10, 8],
    );
    expect(finalized.stripOffsets, offsets);
    expect(finalized.stripByteCounts, <int>[10, 8]);
  });

  test('BigTIFF range check uses the signed Dart offset boundary', () {
    expect(
      () => validateBigTiffWriteRange(
        offset: bigTiffMaximumDartOffset - 10,
        byteCount: 10,
      ),
      returnsNormally,
    );
    expect(
      () => validateBigTiffWriteRange(
        offset: bigTiffMaximumDartOffset - 10,
        byteCount: 11,
      ),
      throwsA(isA<InvalidTiffInput>()),
    );
  });

  test('complete uncompressed BigTIFF smoke file has exact RGB16 samples',
      () async {
    final BigTiff16Header header = encodeBigTiff16Header(
      width: 2,
      height: 2,
    );
    final Uint16List samples = Uint16List.fromList(<int>[
      65535,
      0,
      0,
      0,
      65535,
      0,
      0,
      0,
      65535,
      1234,
      2345,
      3456,
    ]);
    final Uint8List pixels = Uint8List(samples.length * 2);
    final ByteData pixelData = ByteData.sublistView(pixels);
    for (int index = 0; index < samples.length; index++) {
      pixelData.setUint16(index * 2, samples[index], Endian.little);
    }
    final Directory tempDir = await Directory.systemTemp.createTemp(
      'mobile-stack-bigtiff16-test-',
    );
    final File file = File(
      '${tempDir.path}${Platform.pathSeparator}smoke.tiff',
    );
    try {
      await file.writeAsBytes(<int>[...header.bytes, ...pixels], flush: true);
      expect(await file.length(), header.pixelDataOffset + pixels.length);
      final String? smokeOutput =
          Platform.environment['MOBILE_STACK_BIGTIFF_SMOKE_OUTPUT'];
      if (smokeOutput != null && smokeOutput.isNotEmpty) {
        await file.copy(smokeOutput);
      }
    } finally {
      await tempDir.delete(recursive: true);
    }
  });
}
