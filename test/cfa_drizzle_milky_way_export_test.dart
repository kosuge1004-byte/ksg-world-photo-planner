import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/color/linear_rgb_color_transform.dart';
import 'package:mobile_stack/core/demosaic/demosaic_algorithm.dart';
import 'package:mobile_stack/core/demosaic/demosaic_engine.dart';
import 'package:mobile_stack/core/demosaic/demosaic_registry.dart';
import 'package:mobile_stack/core/demosaic/demosaic_request.dart';
import 'package:mobile_stack/core/export/output_image_format.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/session/cfa_drizzle_milky_way_export.dart';
import 'package:mobile_stack/core/session/cfa_drizzle_milky_way_pipeline.dart';

import 'support/in_memory_rgb_tile_store.dart';
import 'support/recording_rgb_tile_store.dart';

/// Tests [compositeCfaDrizzleMilkyWayAndExport] end to end against fake
/// tile stores and a real temp-directory file. The pieces it wires
/// together (`fillDrizzleTiledGaps`, `exportTileStoreToImage`) already
/// have their own dedicated test coverage; this file's job is
/// specifically the new orchestration logic (disposing the intermediate
/// stores, the export actually happening, and that disposal still
/// happens on failure).

Float32List _seededSamples(int width, int height, int seed, double scale) {
  final Float32List samples = Float32List(width * height * 3);
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  for (int i = 0; i < samples.length; i++) {
    samples[i] = next() * scale;
  }
  return samples;
}

CfaDrizzleMilkyWayResult _fakeResult(int width, int height) {
  final InMemoryRgbTileStore valueStore = InMemoryRgbTileStore(
    width: width,
    height: height,
    interleavedRgb: _seededSamples(width, height, 1, 5),
  );
  // coverageを全て正の値にしておく(ギャップ埋めの分岐を経由せず、
  // このテストの主眼である「配線」に集中するため)。
  final Float32List coverageSamples = Float32List(width * height * 3)
    ..fillRange(0, width * height * 3, 2);
  final InMemoryRgbTileStore coverageStore = InMemoryRgbTileStore(
    width: width,
    height: height,
    interleavedRgb: coverageSamples,
  );
  return CfaDrizzleMilkyWayResult(
    valueStore: valueStore,
    coverageStore: coverageStore,
    frameDiagnostics: const <CfaDrizzleMilkyWayFrameDiagnostics>[],
    referenceCfaPattern: CfaPattern.rggb,
    outputScale: 2,
  );
}

void main() {
  test(
    '合成結果がギャップ埋めされ、実際にファイルとして書き出され、'
    '中間ストアが破棄される',
    () async {
      const int width = 12;
      const int height = 10;
      final CfaDrizzleMilkyWayResult result = _fakeResult(width, height);
      final InMemoryRgbTileStore valueStore =
          result.valueStore as InMemoryRgbTileStore;
      final InMemoryRgbTileStore coverageStore =
          result.coverageStore as InMemoryRgbTileStore;
      final RecordingRgbTileStoreFactory gapFillFactory =
          RecordingRgbTileStoreFactory();

      final Directory directory = await Directory.systemTemp.createTemp(
        'mobile-stack-cfa-drizzle-export-',
      );
      final String exportPath =
          '${directory.path}${Platform.pathSeparator}result.tiff';
      try {
        final File written = await compositeCfaDrizzleMilkyWayAndExport(
          result: result,
          gapFillOutputStoreFactory: gapFillFactory.call,
          exportPath: exportPath,
          format: OutputImageFormat.tiff16,
        );

        expect(await written.exists(), isTrue);
        expect(valueStore.isCommitted, isFalse); // dispose済み
        expect(coverageStore.isCommitted, isFalse); // dispose済み
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test('BMP形式でもエクスポートできる', () async {
    const int width = 8;
    const int height = 6;
    final CfaDrizzleMilkyWayResult result = _fakeResult(width, height);
    final RecordingRgbTileStoreFactory gapFillFactory =
        RecordingRgbTileStoreFactory();

    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-cfa-drizzle-export-bmp-',
    );
    final String exportPath =
        '${directory.path}${Platform.pathSeparator}result.bmp';
    try {
      final File written = await compositeCfaDrizzleMilkyWayAndExport(
        result: result,
        gapFillOutputStoreFactory: gapFillFactory.call,
        exportPath: exportPath,
        format: OutputImageFormat.bmp8,
      );
      final Uint8List bytes = await written.readAsBytes();
      expect(bytes[0], 0x42); // 'B'
      expect(bytes[1], 0x4d); // 'M'
    } finally {
      await directory.delete(recursive: true);
    }
  });

  test('optional linear color transform is applied before export', () async {
    const int width = 4;
    const int height = 4;
    final Float32List red = Float32List(width * height * 3);
    for (int pixel = 0; pixel < width * height; pixel++) {
      red[pixel * 3] = 1;
    }
    final Float32List coverage = Float32List(width * height * 3)
      ..fillRange(0, width * height * 3, 1);
    final CfaDrizzleMilkyWayResult result = CfaDrizzleMilkyWayResult(
      valueStore: InMemoryRgbTileStore(
        width: width,
        height: height,
        interleavedRgb: red,
      ),
      coverageStore: InMemoryRgbTileStore(
        width: width,
        height: height,
        interleavedRgb: coverage,
      ),
      frameDiagnostics: const <CfaDrizzleMilkyWayFrameDiagnostics>[],
      referenceCfaPattern: CfaPattern.rggb,
      outputScale: 2,
      outputColorTransform: LinearRgbColorTransform(
        matrix: const <double>[
          0,
          0,
          1,
          0,
          1,
          0,
          1,
          0,
          0,
        ],
      ),
    );
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-color-transform-export-',
    );
    try {
      final File written = await compositeCfaDrizzleMilkyWayAndExport(
        result: result,
        gapFillOutputStoreFactory: RecordingRgbTileStoreFactory().call,
        exportPath: '${directory.path}${Platform.pathSeparator}blue.bmp',
        format: OutputImageFormat.bmp8,
        exposureScale: 1,
        whitePoint: 1,
      );
      final Uint8List bytes = await written.readAsBytes();
      const int firstPixel = 54;
      expect(bytes[firstPixel], greaterThan(0)); // BMP B: transformed blue
      expect(bytes[firstPixel + 1], 0);
      expect(bytes[firstPixel + 2], 0);
    } finally {
      await directory.delete(recursive: true);
    }
  });

  test('ギャップ埋めが失敗しても中間ストアは破棄される', () async {
    final InMemoryRgbTileStore valueStore = InMemoryRgbTileStore(
      width: 4,
      height: 4,
      interleavedRgb: Float32List(4 * 4 * 3),
    );
    final InMemoryRgbTileStore coverageStore = InMemoryRgbTileStore(
      width: 5, // わざと寸法を不一致にし、fillDrizzleTiledGapsを失敗させる
      height: 5,
      interleavedRgb: Float32List(5 * 5 * 3),
    );
    final CfaDrizzleMilkyWayResult result = CfaDrizzleMilkyWayResult(
      valueStore: valueStore,
      coverageStore: coverageStore,
      frameDiagnostics: const <CfaDrizzleMilkyWayFrameDiagnostics>[],
      referenceCfaPattern: CfaPattern.rggb,
      outputScale: 2,
    );

    await expectLater(
      compositeCfaDrizzleMilkyWayAndExport(
        result: result,
        gapFillOutputStoreFactory: RecordingRgbTileStoreFactory().call,
        exportPath: '/tmp/unused.tiff',
      ),
      throwsA(anything),
    );
    expect(valueStore.isCommitted, isFalse);
    expect(coverageStore.isCommitted, isFalse);
  });

  test(
    'localToneStrength>0を指定すると背景が明るくなった状態でエクスポート'
    'され、指定しない場合と出力が異なる(Work102: 配線の検証)',
    () async {
      // Work99自身のend-to-endテストで既に実行検証済みの比率
      // (8x8画像・右上2x2の星・blurRadius=3)を再利用する。
      const int width = 8;
      const int height = 8;
      final Float32List valueSamples = Float32List(width * height * 3);
      for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
          final int index = y * width + x;
          final bool isStar = x >= 6 && y <= 1;
          final double value = isStar ? 5.0 : 0.02;
          valueSamples[index * 3] = value;
          valueSamples[index * 3 + 1] = value;
          valueSamples[index * 3 + 2] = value;
        }
      }
      final Float32List coverageSamples = Float32List(width * height * 3)
        ..fillRange(0, width * height * 3, 2); // 全画素十分なcoverage

      CfaDrizzleMilkyWayResult buildResult() => CfaDrizzleMilkyWayResult(
            valueStore: InMemoryRgbTileStore(
              width: width,
              height: height,
              interleavedRgb: Float32List.fromList(valueSamples),
            ),
            coverageStore: InMemoryRgbTileStore(
              width: width,
              height: height,
              interleavedRgb: Float32List.fromList(coverageSamples),
            ),
            frameDiagnostics: const <CfaDrizzleMilkyWayFrameDiagnostics>[],
            referenceCfaPattern: CfaPattern.rggb,
            outputScale: 2,
          );

      final Directory tempDir = await Directory.systemTemp.createTemp(
        'mobile-stack-cfa-drizzle-local-tone-',
      );
      try {
        final String plainPath =
            '${tempDir.path}${Platform.pathSeparator}plain.bmp';
        final String localTonePath =
            '${tempDir.path}${Platform.pathSeparator}local-tone.bmp';

        await compositeCfaDrizzleMilkyWayAndExport(
          result: buildResult(),
          gapFillOutputStoreFactory: RecordingRgbTileStoreFactory().call,
          exportPath: plainPath,
          format: OutputImageFormat.bmp8,
          tileSize: 64,
          exposureScale: 1,
          whitePoint: 5,
        );
        await compositeCfaDrizzleMilkyWayAndExport(
          result: buildResult(),
          gapFillOutputStoreFactory: RecordingRgbTileStoreFactory().call,
          exportPath: localTonePath,
          format: OutputImageFormat.bmp8,
          tileSize: 64,
          exposureScale: 1,
          whitePoint: 5,
          localToneStrength: 0.5,
          localToneBlurRadius: 3,
          localToneMinGain: 0.1,
          localToneMaxGain: 10,
        );

        final Uint8List plainBytes = await File(plainPath).readAsBytes();
        final Uint8List localToneBytes =
            await File(localTonePath).readAsBytes();
        // BMPは54バイトヘッダー後、下から上・BGR順で格納される。
        // 一番下の行(y=height-1=7)の先頭画素(x=0)は星から最も離れた
        // 背景領域。
        const int pixelDataOffset = 54;
        expect(
          localToneBytes[pixelDataOffset],
          greaterThan(plainBytes[pixelDataOffset]),
          reason: 'expected local tone adaptation to brighten the '
              'background in the exported file',
        );
      } finally {
        await tempDir.delete(recursive: true);
      }
    },
  );

  test(
    'useRealDemosaic=trueかつoutputScale!=1だとArgumentErrorを投げる'
    '(Work112)',
    () async {
      final CfaDrizzleMilkyWayResult result = _fakeResult(4, 4);
      await expectLater(
        compositeCfaDrizzleMilkyWayAndExport(
          result: result,
          gapFillOutputStoreFactory: RecordingRgbTileStoreFactory().call,
          exportPath: '/tmp/unused.tiff',
          useRealDemosaic: true,
          demosaicRegistry: DemosaicRegistry(<DemosaicEngine>[]),
        ),
        throwsA(isA<ArgumentError>()),
      );
    },
  );

  test(
    'useRealDemosaic=trueかつdemosaicRegistryが未指定だとArgumentErrorを'
    '投げる(Work112)',
    () async {
      final CfaDrizzleMilkyWayResult result = CfaDrizzleMilkyWayResult(
        valueStore: InMemoryRgbTileStore(
          width: 4,
          height: 4,
          interleavedRgb: Float32List(4 * 4 * 3),
        ),
        coverageStore: InMemoryRgbTileStore(
          width: 4,
          height: 4,
          interleavedRgb: Float32List(4 * 4 * 3),
        ),
        frameDiagnostics: const <CfaDrizzleMilkyWayFrameDiagnostics>[],
        referenceCfaPattern: CfaPattern.rggb,
        outputScale: 1,
      );
      await expectLater(
        compositeCfaDrizzleMilkyWayAndExport(
          result: result,
          gapFillOutputStoreFactory: RecordingRgbTileStoreFactory().call,
          exportPath: '/tmp/unused.tiff',
          useRealDemosaic: true,
        ),
        throwsA(isA<ArgumentError>()),
      );
    },
  );

  test(
    'useRealDemosaic=trueかつoutputScale=1・demosaicRegistry指定済みの'
    '場合、実際にデモザイクエンジンを経由してエクスポートされる'
    '(Work112: 配線の検証)',
    () async {
      const int width = 6;
      const int height = 6;
      final Float32List valueSamples = Float32List(width * height * 3)
        ..fillRange(0, width * height * 3, 0.3);
      final Float32List coverageSamples = Float32List(width * height * 3)
        ..fillRange(0, width * height * 3, 2);
      final CfaDrizzleMilkyWayResult result = CfaDrizzleMilkyWayResult(
        valueStore: InMemoryRgbTileStore(
          width: width,
          height: height,
          interleavedRgb: valueSamples,
        ),
        coverageStore: InMemoryRgbTileStore(
          width: width,
          height: height,
          interleavedRgb: coverageSamples,
        ),
        frameDiagnostics: const <CfaDrizzleMilkyWayFrameDiagnostics>[],
        referenceCfaPattern: CfaPattern.rggb,
        outputScale: 1,
      );
      final DemosaicRegistry registry = DemosaicRegistry(<DemosaicEngine>[
        _StubProductionDemosaic(),
      ]);
      final Directory tempDir = await Directory.systemTemp.createTemp(
        'mobile-stack-cfa-drizzle-real-demosaic-',
      );
      try {
        final String outputPath =
            '${tempDir.path}${Platform.pathSeparator}result.bmp';
        final File written = await compositeCfaDrizzleMilkyWayAndExport(
          result: result,
          gapFillOutputStoreFactory: RecordingRgbTileStoreFactory().call,
          exportPath: outputPath,
          format: OutputImageFormat.bmp8,
          useRealDemosaic: true,
          demosaicRegistry: registry,
          exposureScale: 1,
          whitePoint: 1,
        );
        expect(await written.exists(), isTrue);
      } finally {
        await tempDir.delete(recursive: true);
      }
    },
  );
}

/// エンジン自体の数値的な正しさはこのテストの主眼ではない
/// (`demosaic_reconstructed_mosaic_test.dart`, Work112が既に検証済み)
/// ため、既存の`_TestProductionDemosaic`
/// (`phase2_validated_job_executor_test.dart`)と同じ、固定値を返す
/// スタブを使う。
class _StubProductionDemosaic implements DemosaicEngine {
  @override
  DemosaicAlgorithm get algorithm => DemosaicAlgorithm.mobileStackAdaptive;

  @override
  bool get isProductionQuality => true;

  @override
  int get requiredInputRadius => 4;

  @override
  Future<LinearRgbTile> processTile(DemosaicRequest request) async {
    return LinearRgbTile(
      x: request.tile.outputX,
      y: request.tile.outputY,
      width: request.tile.outputWidth,
      height: request.tile.outputHeight,
      interleavedRgb: Float32List(
        request.tile.outputWidth * request.tile.outputHeight * 3,
      )..fillRange(
          0,
          request.tile.outputWidth * request.tile.outputHeight * 3,
          0.3,
        ),
    );
  }
}
