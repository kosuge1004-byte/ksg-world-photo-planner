import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/export_result.dart';
import 'package:mobile_stack/core/export/output_image_format.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/session/export_pipeline_result.dart';

import 'support/in_memory_rgb_tile_store.dart';
import 'support/recording_rgb_tile_store.dart';

/// Tests the two directly-testable "combine already-decoded frames and
/// export" wrappers ([combineDecodedFramesAndExport],
/// [registerAndCombineDecodedFramesAndExport]) end to end against a real
/// temp-directory file. See `export_pipeline_result.dart`'s own doc
/// comment for why the `JobScheduler`-driven full-pipeline wrappers
/// ([runStarTrailPipelineAndExport], [runMilkyWayPipelineAndExport]) are
/// *not* covered here.

InMemoryRgbTileStore _constantFrame(
  int width,
  int height,
  double red,
  double green,
  double blue,
) {
  final Float32List rgb = Float32List(width * height * 3);
  for (int pixel = 0; pixel < width * height; pixel++) {
    rgb[pixel * 3] = red;
    rgb[pixel * 3 + 1] = green;
    rgb[pixel * 3 + 2] = blue;
  }
  return InMemoryRgbTileStore(
    width: width,
    height: height,
    interleavedRgb: rgb,
  );
}

void main() {
  test(
    'combineDecodedFramesAndExport: TIFF指定は実際の16bit TIFFを書き出す',
    () async {
      const int width = 3;
      const int height = 2;
      final RecordingRgbTileStoreFactory intermediateFactory =
          RecordingRgbTileStoreFactory();
      final Directory tempDir = await Directory.systemTemp.createTemp(
        'mobile-stack-pipeline-export-tiff-',
      );
      final String exportPath =
          '${tempDir.path}${Platform.pathSeparator}result.tiff';
      try {
        final File written = await combineDecodedFramesAndExport(
          frameStores: <LinearRgbTileStore>[
            _constantFrame(width, height, 0.1, 0.2, 0.3),
            _constantFrame(width, height, 0.2, 0.1, 0.4),
          ],
          outputTileStoreFactory: intermediateFactory.call,
          exportPath: exportPath,
          outputFormat: OutputImageFormat.tiff16,
          exposureScale: 1,
          whitePoint: 1,
        );
        final Uint8List bytes = await written.readAsBytes();
        expect(bytes.sublist(0, 4), <int>[0x49, 0x49, 42, 0]);
        expect(intermediateFactory.latest!.disposed, isTrue);
      } finally {
        await tempDir.delete(recursive: true);
      }
    },
  );

  test(
    'combineDecodedFramesAndExport: 星の軌跡モードの合成結果が実際にBMP'
    'ファイルとして書き出され、中間ストアが破棄される',
    () async {
      const int width = 10;
      const int height = 8;
      final InMemoryRgbTileStore frameA =
          _constantFrame(width, height, 1, 5, 2);
      final InMemoryRgbTileStore frameB =
          _constantFrame(width, height, 3, 1, 9);
      final RecordingRgbTileStoreFactory intermediateFactory =
          RecordingRgbTileStoreFactory();

      final Directory tempDir = await Directory.systemTemp.createTemp(
        'mobile-stack-pipeline-export-startrail-',
      );
      final String exportPath =
          '${tempDir.path}${Platform.pathSeparator}result.bmp';
      try {
        final File written = await combineDecodedFramesAndExport(
          frameStores: <LinearRgbTileStore>[frameA, frameB],
          outputTileStoreFactory: intermediateFactory.call,
          exportPath: exportPath,
          tileSize: 512,
        );

        expect(await written.exists(), isTrue);
        final Uint8List bytes = await written.readAsBytes();
        expect(bytes[0], 0x42); // 'B'
        expect(bytes[1], 0x4d); // 'M'
        final ByteData view = ByteData.sublistView(bytes);
        expect(view.getInt32(18, Endian.little), width);
        expect(view.getInt32(22, Endian.little), height);

        // 中間の(比較明合成済みだがトーンマッピング前の)ストアは、
        // エクスポート完了後に破棄されているはず。
        expect(intermediateFactory.latest!.disposed, isTrue);
      } finally {
        await tempDir.delete(recursive: true);
      }
    },
  );

  test(
    'combineDecodedFramesAndExport: 合成後のBMP書き出しにもキャンセルを'
    '伝播し、中間ストアと部分出力を後始末する',
    () async {
      const int width = 4;
      const int height = 4;
      final InMemoryRgbTileStore frameA =
          _constantFrame(width, height, 1, 1, 1);
      final InMemoryRgbTileStore frameB =
          _constantFrame(width, height, 2, 2, 2);
      final RecordingRgbTileStoreFactory intermediateFactory =
          RecordingRgbTileStoreFactory();
      final Directory tempDir = await Directory.systemTemp.createTemp(
        'mobile-stack-pipeline-export-cancel-',
      );
      final String exportPath =
          '${tempDir.path}${Platform.pathSeparator}partial.bmp';
      int exportCancellationChecks = 0;
      try {
        await expectLater(
          combineDecodedFramesAndExport(
            frameStores: <LinearRgbTileStore>[frameA, frameB],
            outputTileStoreFactory: intermediateFactory.call,
            exportPath: exportPath,
            tileSize: 512,
            exposureScale: 1,
            whitePoint: 1,
            // Allow the combiner to commit, then cancel after the exporter
            // opens the output and writes its header.
            isCancelled: () {
              if (!(intermediateFactory.latest?.isCommitted ?? false)) {
                return false;
              }
              return exportCancellationChecks++ >= 2;
            },
          ),
          throwsA(isA<ExportCancelled>()),
        );
        expect(intermediateFactory.latest!.disposed, isTrue);
        expect(await File(exportPath).exists(), isFalse);
      } finally {
        await tempDir.delete(recursive: true);
      }
    },
  );

  test(
    'registerAndCombineDecodedFramesAndExport: Milky Wayモードの合成結'
    '果が実際にBMPファイルとして書き出され、中間ストアが破棄される',
    () async {
      const int width = 12;
      const int height = 10;
      final InMemoryRgbTileStore referenceStore =
          _constantFrame(width, height, 0.02, 0.03, 0.05);
      final RecordingRgbTileStoreFactory intermediateFactory =
          RecordingRgbTileStoreFactory();

      final Directory tempDir = await Directory.systemTemp.createTemp(
        'mobile-stack-pipeline-export-milkyway-',
      );
      final String exportPath =
          '${tempDir.path}${Platform.pathSeparator}result.bmp';
      try {
        // 参照フレーム1枚のみ(minRegisteredFrames=1にして単独でも
        // 処理が完了することを確認する -- 実際の星検出・変換推定の
        // 精度そのものは milky_way_pipeline_test.dart 側で既に厳密に
        // 検証済みなので、ここでは「合成からエクスポートまでが正しく
        // 繋がっているか」だけを確認する)。
        final File written = await registerAndCombineDecodedFramesAndExport(
          sourcePaths: <String>['ref.arw'],
          frameStores: <LinearRgbTileStore?>[referenceStore],
          decodeFailures: const <int, Object?>{},
          outputTileStoreFactory: intermediateFactory.call,
          exportPath: exportPath,
          tileSize: 512,
          minRegisteredFrames: 1,
        );

        expect(await written.exists(), isTrue);
        final Uint8List bytes = await written.readAsBytes();
        expect(bytes[0], 0x42);
        expect(bytes[1], 0x4d);
        final ByteData view = ByteData.sublistView(bytes);
        expect(view.getInt32(18, Endian.little), width);
        expect(view.getInt32(22, Endian.little), height);
        expect(intermediateFactory.latest!.disposed, isTrue);
      } finally {
        await tempDir.delete(recursive: true);
      }
    },
  );

  test(
    'combineDecodedFramesAndExport: エクスポート自体が失敗しても中間ス'
    'トアは破棄される(finallyでの後始末を確認)',
    () async {
      const int width = 4;
      const int height = 4;
      final InMemoryRgbTileStore frameA =
          _constantFrame(width, height, 1, 1, 1);
      final InMemoryRgbTileStore frameB =
          _constantFrame(width, height, 2, 2, 2);
      final RecordingRgbTileStoreFactory intermediateFactory =
          RecordingRgbTileStoreFactory();

      // 存在しないディレクトリを指すパスを渡し、File.writeAsBytes が
      // 失敗するようにする。
      const String invalidExportPath =
          '/this/path/definitely/does/not/exist/result.bmp';
      await expectLater(
        combineDecodedFramesAndExport(
          frameStores: <LinearRgbTileStore>[frameA, frameB],
          outputTileStoreFactory: intermediateFactory.call,
          exportPath: invalidExportPath,
          tileSize: 512,
        ),
        throwsA(anything),
      );
      expect(intermediateFactory.latest!.disposed, isTrue);
    },
  );
}
