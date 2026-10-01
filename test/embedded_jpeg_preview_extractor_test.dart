import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/raw/embedded_jpeg_preview_extractor.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_probe_result.dart';

void main() {
  late Directory temporaryDirectory;

  setUp(() async {
    temporaryDirectory =
        await Directory.systemTemp.createTemp('mobile_stack_preview_');
  });

  tearDown(() async {
    if (await temporaryDirectory.exists()) {
      await temporaryDirectory.delete(recursive: true);
    }
  });

  Future<({File file, List<int> jpeg})> writeTiffWithPreview({
    int declaredLength = 10,
  }) async {
    final Uint8List bytes = Uint8List(128);
    final ByteData data = ByteData.sublistView(bytes);
    const int ifdOffset = 8;
    const int jpegOffset = 64;
    const List<int> jpeg = <int>[
      0xFF,
      0xD8,
      0xFF,
      0xE0,
      0x00,
      0x02,
      0x11,
      0x22,
      0xFF,
      0xD9,
    ];

    bytes[0] = 0x49;
    bytes[1] = 0x49;
    data.setUint16(2, 0x002A, Endian.little);
    data.setUint32(4, ifdOffset, Endian.little);
    data.setUint16(ifdOffset, 2, Endian.little);

    int entry = ifdOffset + 2;
    data.setUint16(entry, 0x0201, Endian.little);
    data.setUint16(entry + 2, 4, Endian.little);
    data.setUint32(entry + 4, 1, Endian.little);
    data.setUint32(entry + 8, jpegOffset, Endian.little);

    entry += 12;
    data.setUint16(entry, 0x0202, Endian.little);
    data.setUint16(entry + 2, 4, Endian.little);
    data.setUint32(entry + 4, 1, Endian.little);
    data.setUint32(entry + 8, declaredLength, Endian.little);
    data.setUint32(ifdOffset + 2 + 24, 0, Endian.little);

    bytes.setRange(jpegOffset, jpegOffset + jpeg.length, jpeg);
    final File file = File(
      '${temporaryDirectory.path}${Platform.pathSeparator}preview.dng',
    );
    await file.writeAsBytes(bytes);
    return (file: file, jpeg: jpeg);
  }

  RawProbeResult acceptedProbe(
    File file, {
    RawFormat format = RawFormat.dng,
  }) =>
      RawProbeResult(
        path: file.path,
        format: format,
        byteLength: file.lengthSync(),
        isReadable: true,
        signatureMatched: true,
      );

  test('TIFF IFDの埋め込みJPEGを抽出する', () async {
    final (:file, :jpeg) = await writeTiffWithPreview();
    const TiffEmbeddedJpegPreviewExtractor extractor =
        TiffEmbeddedJpegPreviewExtractor();

    final RawEmbeddedPreview? preview =
        await extractor.extract(acceptedProbe(file));

    expect(preview, isNotNull);
    expect(preview!.sourceOffset, 64);
    expect(preview.bytes, orderedEquals(jpeg));
    expect(preview.mimeType, 'image/jpeg');
  });

  test('ファイル外を指すプレビューを読み込まない', () async {
    final (:file, :jpeg) = await writeTiffWithPreview(
      declaredLength: 1000,
    );
    expect(jpeg, isNotEmpty);
    const TiffEmbeddedJpegPreviewExtractor extractor =
        TiffEmbeddedJpegPreviewExtractor();

    final RawEmbeddedPreview? preview =
        await extractor.extract(acceptedProbe(file));

    expect(preview, isNull);
  });

  test('上限を超えるプレビューを読み込まない', () async {
    final (:file, :jpeg) = await writeTiffWithPreview();
    expect(jpeg, isNotEmpty);
    const TiffEmbeddedJpegPreviewExtractor extractor =
        TiffEmbeddedJpegPreviewExtractor(maximumPreviewBytes: 8);

    final RawEmbeddedPreview? preview =
        await extractor.extract(acceptedProbe(file));

    expect(preview, isNull);
  });

  test('Sony ARW相当の複数IFDから最大の有効JPEGを選ぶ', () async {
    final Uint8List bytes = Uint8List(512);
    final ByteData data = ByteData.sublistView(bytes);
    const int firstIfdOffset = 8;
    const int secondIfdOffset = 64;
    const int smallJpegOffset = 300;
    const int largeJpegOffset = 340;
    const List<int> smallJpeg = <int>[
      0xFF,
      0xD8,
      0xFF,
      0xE0,
      0x00,
      0x02,
      0x11,
      0x22,
      0xFF,
      0xD9,
    ];
    const List<int> largeJpeg = <int>[
      0xFF,
      0xD8,
      0xFF,
      0xE0,
      0x00,
      0x02,
      0x11,
      0x22,
      0x33,
      0x44,
      0x55,
      0x66,
      0x77,
      0x88,
      0x99,
      0xAA,
      0xBB,
      0xCC,
      0xFF,
      0xD9,
    ];

    bytes[0] = 0x49;
    bytes[1] = 0x49;
    data.setUint16(2, 0x002A, Endian.little);
    data.setUint32(4, firstIfdOffset, Endian.little);

    void writePreviewIfd(
      int ifdOffset,
      int jpegOffset,
      int jpegLength,
      int nextIfd,
    ) {
      data.setUint16(ifdOffset, 2, Endian.little);
      int entry = ifdOffset + 2;
      data.setUint16(entry, 0x0201, Endian.little);
      data.setUint16(entry + 2, 4, Endian.little);
      data.setUint32(entry + 4, 1, Endian.little);
      data.setUint32(entry + 8, jpegOffset, Endian.little);
      entry += 12;
      data.setUint16(entry, 0x0202, Endian.little);
      data.setUint16(entry + 2, 4, Endian.little);
      data.setUint32(entry + 4, 1, Endian.little);
      data.setUint32(entry + 8, jpegLength, Endian.little);
      data.setUint32(ifdOffset + 2 + 24, nextIfd, Endian.little);
    }

    writePreviewIfd(
      firstIfdOffset,
      smallJpegOffset,
      smallJpeg.length,
      secondIfdOffset,
    );
    writePreviewIfd(
      secondIfdOffset,
      largeJpegOffset,
      largeJpeg.length,
      0,
    );
    bytes.setRange(
      smallJpegOffset,
      smallJpegOffset + smallJpeg.length,
      smallJpeg,
    );
    bytes.setRange(
      largeJpegOffset,
      largeJpegOffset + largeJpeg.length,
      largeJpeg,
    );
    final File file = File(
      '${temporaryDirectory.path}${Platform.pathSeparator}sony-sample.arw',
    );
    await file.writeAsBytes(bytes);
    const TiffEmbeddedJpegPreviewExtractor extractor =
        TiffEmbeddedJpegPreviewExtractor();

    final RawEmbeddedPreview? preview = await extractor.extract(
      acceptedProbe(file, format: RawFormat.arw),
    );

    expect(preview, isNotNull);
    expect(preview!.sourceOffset, largeJpegOffset);
    expect(preview.bytes, orderedEquals(largeJpeg));
  });
}
