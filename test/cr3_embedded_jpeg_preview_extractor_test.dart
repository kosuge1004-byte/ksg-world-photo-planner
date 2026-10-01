import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/raw/cr3_embedded_jpeg_preview_extractor.dart';
import 'package:mobile_stack/core/raw/embedded_jpeg_preview_extractor.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_probe_result.dart';

void main() {
  late Directory temporaryDirectory;

  setUp(() async {
    temporaryDirectory =
        await Directory.systemTemp.createTemp('mobile_stack_cr3_preview_');
  });

  tearDown(() async {
    if (await temporaryDirectory.exists()) {
      await temporaryDirectory.delete(recursive: true);
    }
  });

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

  Future<File> writeCr3({
    String boxTag = 'PRVW',
    int boxOffset = 80,
    int? declaredJpegLength,
    int? declaredBoxLength,
  }) async {
    final Uint8List bytes = Uint8List(256);
    final ByteData data = ByteData.sublistView(bytes);

    data.setUint32(0, 24, Endian.big);
    bytes.setRange(4, 8, 'ftyp'.codeUnits);
    bytes.setRange(8, 12, 'crx '.codeUnits);

    final int jpegLength = declaredJpegLength ?? jpeg.length;
    data.setUint32(
      boxOffset,
      declaredBoxLength ?? 24 + jpeg.length,
      Endian.big,
    );
    bytes.setRange(boxOffset + 4, boxOffset + 8, boxTag.codeUnits);
    if (boxTag == 'PRVW') {
      data.setUint16(boxOffset + 14, 1620, Endian.big);
      data.setUint16(boxOffset + 16, 1080, Endian.big);
      data.setUint32(boxOffset + 20, jpegLength, Endian.big);
    } else {
      data.setUint16(boxOffset + 12, 320, Endian.big);
      data.setUint16(boxOffset + 14, 214, Endian.big);
      data.setUint32(boxOffset + 16, jpegLength, Endian.big);
    }
    bytes.setRange(boxOffset + 24, boxOffset + 24 + jpeg.length, jpeg);

    final File file = File(
      '${temporaryDirectory.path}${Platform.pathSeparator}preview.cr3',
    );
    await file.writeAsBytes(bytes);
    return file;
  }

  RawProbeResult acceptedProbe(File file) => RawProbeResult(
        path: file.path,
        format: RawFormat.cr3,
        byteLength: file.lengthSync(),
        isReadable: true,
        signatureMatched: true,
      );

  test('CR3のPRVWボックスからJPEGを抽出する', () async {
    final File file = await writeCr3(boxOffset: 27);
    const Cr3EmbeddedJpegPreviewExtractor extractor =
        Cr3EmbeddedJpegPreviewExtractor(scanChunkBytes: 32);

    final RawEmbeddedPreview? preview =
        await extractor.extract(acceptedProbe(file));

    expect(preview, isNotNull);
    expect(preview!.sourceOffset, 51);
    expect(preview.bytes, orderedEquals(jpeg));
  });

  test('CR3のTHMBボックスにも対応する', () async {
    final File file = await writeCr3(boxTag: 'THMB');
    const Cr3EmbeddedJpegPreviewExtractor extractor =
        Cr3EmbeddedJpegPreviewExtractor();

    final RawEmbeddedPreview? preview =
        await extractor.extract(acceptedProbe(file));

    expect(preview, isNotNull);
    expect(preview!.bytes, orderedEquals(jpeg));
  });

  test('ボックス外へはみ出すJPEG宣言を拒否する', () async {
    final File file = await writeCr3(
      declaredJpegLength: 100,
      declaredBoxLength: 34,
    );
    const Cr3EmbeddedJpegPreviewExtractor extractor =
        Cr3EmbeddedJpegPreviewExtractor();

    final RawEmbeddedPreview? preview =
        await extractor.extract(acceptedProbe(file));

    expect(preview, isNull);
  });

  test('プレビュー容量上限を超えるJPEGを読み込まない', () async {
    final File file = await writeCr3();
    const Cr3EmbeddedJpegPreviewExtractor extractor =
        Cr3EmbeddedJpegPreviewExtractor(maximumPreviewBytes: 8);

    final RawEmbeddedPreview? preview =
        await extractor.extract(acceptedProbe(file));

    expect(preview, isNull);
  });
}
