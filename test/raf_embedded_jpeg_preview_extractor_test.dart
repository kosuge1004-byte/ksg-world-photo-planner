import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/raw/embedded_jpeg_preview_extractor.dart';
import 'package:mobile_stack/core/raw/raf_embedded_jpeg_preview_extractor.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_probe_result.dart';

void main() {
  late Directory temporaryDirectory;

  setUp(() async {
    temporaryDirectory =
        await Directory.systemTemp.createTemp('mobile_stack_raf_preview_');
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
    0xE1,
    0x00,
    0x02,
    0x33,
    0x44,
    0xFF,
    0xD9,
  ];

  Future<File> writeRaf({
    int previewOffset = 128,
    int? declaredLength,
  }) async {
    final Uint8List bytes = Uint8List(256);
    final ByteData data = ByteData.sublistView(bytes);
    bytes.setRange(0, 16, 'FUJIFILMCCD-RAW '.codeUnits);
    data.setUint32(84, previewOffset, Endian.big);
    data.setUint32(88, declaredLength ?? jpeg.length, Endian.big);
    if (previewOffset + jpeg.length <= bytes.length) {
      bytes.setRange(previewOffset, previewOffset + jpeg.length, jpeg);
    }

    final File file = File(
      '${temporaryDirectory.path}${Platform.pathSeparator}preview.raf',
    );
    await file.writeAsBytes(bytes);
    return file;
  }

  RawProbeResult acceptedProbe(File file) => RawProbeResult(
        path: file.path,
        format: RawFormat.raf,
        byteLength: file.lengthSync(),
        isReadable: true,
        signatureMatched: true,
      );

  test('RAFヘッダーが指すJPEGプレビューを抽出する', () async {
    final File file = await writeRaf();
    const RafEmbeddedJpegPreviewExtractor extractor =
        RafEmbeddedJpegPreviewExtractor();

    final RawEmbeddedPreview? preview =
        await extractor.extract(acceptedProbe(file));

    expect(preview, isNotNull);
    expect(preview!.sourceOffset, 128);
    expect(preview.bytes, orderedEquals(jpeg));
  });

  test('ファイル外を指すプレビュー宣言を拒否する', () async {
    final File file = await writeRaf(
      previewOffset: 250,
      declaredLength: 32,
    );
    const RafEmbeddedJpegPreviewExtractor extractor =
        RafEmbeddedJpegPreviewExtractor();

    final RawEmbeddedPreview? preview =
        await extractor.extract(acceptedProbe(file));

    expect(preview, isNull);
  });

  test('JPEGシグネチャが一致しないデータを拒否する', () async {
    final File file = await writeRaf();
    final Uint8List bytes = await file.readAsBytes();
    bytes[128] = 0;
    await file.writeAsBytes(bytes);
    const RafEmbeddedJpegPreviewExtractor extractor =
        RafEmbeddedJpegPreviewExtractor();

    final RawEmbeddedPreview? preview =
        await extractor.extract(acceptedProbe(file));

    expect(preview, isNull);
  });
}
