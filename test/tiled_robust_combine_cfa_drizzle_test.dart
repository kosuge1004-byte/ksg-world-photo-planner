import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/cfa_drizzle.dart';
import 'package:mobile_stack/core/drizzle/drizzle_accumulator.dart';
import 'package:mobile_stack/core/drizzle/parallel_robust_cfa_drizzle.dart';
import 'package:mobile_stack/core/drizzle/robust_combine_cfa_drizzle.dart';
import 'package:mobile_stack/core/drizzle/tiled_cfa_drizzle.dart';
import 'package:mobile_stack/core/drizzle/tiled_robust_combine_cfa_drizzle.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_raw_mosaic_store.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';

import 'support/in_memory_rgb_tile_store.dart';
import 'support/recording_rgb_tile_store.dart';

/// The key correctness check for
/// `tiled_robust_combine_cfa_drizzle.dart`: confirms the tile-by-tile
/// restructuring produces numerically identical results to the
/// already-tested whole-image `robustCombineCfaDrizzleResults` on the
/// same synthetic multi-frame data — the same "tiled version matches
/// the whole-frame version exactly" discipline established for
/// `tiled_cfa_drizzle.dart` (Work87).

int _seedState = 0;
double _next() {
  _seedState = (_seedState * 1103515245 + 12345) & 0x7fffffff;
  return _seedState / 0x7fffffff;
}

List<CfaDrizzleResult> _seededPerFrameResults(
  int width,
  int height,
  int frameCount, {
  required int seed,
  double outlierProbability = 0.05,
}) {
  _seedState = seed;
  return List<CfaDrizzleResult>.generate(frameCount, (int f) {
    final List<DrizzleResult> channels = <DrizzleResult>[
      for (int c = 0; c < 3; c++)
        DrizzleResult(
          width: width,
          height: height,
          value: Float64List(width * height),
          coverage: Float64List(width * height),
        ),
    ];
    for (int c = 0; c < 3; c++) {
      for (int i = 0; i < width * height; i++) {
        // 「実際の星/背景」を模した、フレーム間でほぼ一致する基準値に
        // 小さなノイズを加える。
        final double baseline = 50 + (i % 7) * 3.0;
        final bool isOutlier = _next() < outlierProbability;
        final double value = isOutlier
            ? baseline + 500 + _next() * 200 // 宇宙線ヒットのような外れ値
            : baseline + (_next() - 0.5) * 4; // 通常のフレーム間ばらつき
        final bool hasCoverage = _next() > 0.1; // 約90%の画素で寄与
        channels[c].value[i] = value;
        channels[c].coverage[i] = hasCoverage ? 1 + _next() : 0;
      }
    }
    return CfaDrizzleResult(
      width: width,
      height: height,
      channels: channels,
    );
  });
}

void main() {
  test('64枚をフルサイズ中間画像なしで処理し旧方式と画素一致する', () async {
    const int width = 8;
    const int height = 8;
    const int frameCount = 64;
    final List<FileBackedLinearRawMosaicStore> rawStores =
        <FileBackedLinearRawMosaicStore>[];
    final List<CfaDrizzleTiledFrame> frames = <CfaDrizzleTiledFrame>[];
    final List<LinearRgbTileStore> referenceValues = <LinearRgbTileStore>[];
    final List<LinearRgbTileStore> referenceCoverage = <LinearRgbTileStore>[];
    try {
      for (int frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        final Float32List samples = Float32List(width * height);
        for (int pixel = 0; pixel < samples.length; pixel++) {
          samples[pixel] = 100 + (pixel % 11) + frameIndex * 0.01;
        }
        // One large transient is intentionally rejected by the same
        // median/MAD path used by production Milky Way stacks.
        if (frameIndex == frameCount - 1) samples[18] = 10000;
        final FileBackedLinearRawMosaicStore store =
            await FileBackedLinearRawMosaicStore.createTemporary(
          width: width,
          height: height,
          cfaPattern: CfaPattern.rggb,
        );
        rawStores.add(store);
        await store.writeFull(LinearRawMosaic(
          width: width,
          height: height,
          cfaPattern: CfaPattern.rggb,
          samples: samples,
        ));
        final CfaDrizzleTiledFrame frame = CfaDrizzleTiledFrame(
          mosaicStore: store,
        );
        frames.add(frame);

        // The former production route is retained here only as a small-image
        // numerical oracle. It materializes one result store per frame.
        final CfaDrizzleTiledResult oldResult = await drizzleCfaTiled(
          frames: <CfaDrizzleTiledFrame>[frame],
          outputWidth: width,
          outputHeight: height,
          valueStoreFactory: RecordingRgbTileStoreFactory().call,
          coverageStoreFactory: RecordingRgbTileStoreFactory().call,
          tileSize: 4,
          outputScale: 1,
          pixfrac: 1,
        );
        referenceValues.add(oldResult.valueStore);
        referenceCoverage.add(oldResult.coverageStore);
      }

      final ({
        LinearRgbTileStore valueStore,
        LinearRgbTileStore coverageStore,
      }) reference = await robustCombineCfaDrizzleTiledResults(
        valueStores: referenceValues,
        coverageStores: referenceCoverage,
        outputValueStoreFactory: RecordingRgbTileStoreFactory().call,
        outputCoverageStoreFactory: RecordingRgbTileStoreFactory().call,
        tileSize: 4,
      );
      final RecordingRgbTileStoreFactory streamedValueFactory =
          RecordingRgbTileStoreFactory();
      final RecordingRgbTileStoreFactory streamedCoverageFactory =
          RecordingRgbTileStoreFactory();
      final StreamingRobustCfaDrizzleResult streamed =
          await robustDrizzleCfaFramesStreamingTiled(
        frames: frames,
        outputWidth: width,
        outputHeight: height,
        valueStoreFactory: streamedValueFactory.call,
        coverageStoreFactory: streamedCoverageFactory.call,
        tileSize: 4,
        outputScale: 1,
        pixfrac: 1,
      );
      final StreamingRobustCfaDrizzleResult parallel =
          await robustDrizzleCfaFramesParallelTiled(
        frames: frames,
        outputWidth: width,
        outputHeight: height,
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        tileSize: 4,
        maximumWorkers: 4,
        outputScale: 1,
        pixfrac: 1,
      );
      final StreamingRobustCfaDrizzleResult completionFirst =
          await robustDrizzleCfaFramesParallelTiled(
        frames: frames,
        outputWidth: width,
        outputHeight: height,
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        tileSize: 4,
        maximumWorkers: 1,
        tileCooldown: const Duration(milliseconds: 1),
        outputScale: 1,
        pixfrac: 1,
      );

      // Frame count does not multiply persistent output stores.
      expect(streamedValueFactory.created, hasLength(1));
      expect(streamedCoverageFactory.created, hasLength(1));
      final referenceValueTile = await reference.valueStore.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      final referenceCoverageTile = await reference.coverageStore.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      final streamedValueTile = await streamed.valueStore.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      final streamedCoverageTile = await streamed.coverageStore.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      final parallelValueTile = await parallel.valueStore.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      final parallelCoverageTile = await parallel.coverageStore.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      final completionFirstValueTile =
          await completionFirst.valueStore.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      final completionFirstCoverageTile =
          await completionFirst.coverageStore.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      for (int index = 0;
          index < referenceValueTile.interleavedRgb.length;
          index++) {
        expect(
          streamedValueTile.interleavedRgb[index],
          closeTo(referenceValueTile.interleavedRgb[index], 1e-5),
          reason: 'value mismatch at interleaved index $index',
        );
        expect(
          streamedCoverageTile.interleavedRgb[index],
          closeTo(referenceCoverageTile.interleavedRgb[index], 1e-5),
          reason: 'coverage mismatch at interleaved index $index',
        );
        expect(
          parallelValueTile.interleavedRgb[index],
          streamedValueTile.interleavedRgb[index],
          reason: 'parallel value mismatch at interleaved index $index',
        );
        expect(
          parallelCoverageTile.interleavedRgb[index],
          streamedCoverageTile.interleavedRgb[index],
          reason: 'parallel coverage mismatch at interleaved index $index',
        );
        expect(
          completionFirstValueTile.interleavedRgb[index],
          streamedValueTile.interleavedRgb[index],
          reason: 'completion-first value mismatch at interleaved index $index',
        );
        expect(
          completionFirstCoverageTile.interleavedRgb[index],
          streamedCoverageTile.interleavedRgb[index],
          reason:
              'completion-first coverage mismatch at interleaved index $index',
        );
      }
    } finally {
      for (final FileBackedLinearRawMosaicStore store in rawStores) {
        await store.dispose();
      }
    }
  });

  for (final int tileSize in <int>[4, 7, 100]) {
    test(
      'tileSize=$tileSizeでの結果が、全画像一括版の'
      'robustCombineCfaDrizzleResultsと数値的に一致する',
      () async {
        const int width = 15;
        const int height = 13;
        const int frameCount = 8;
        final List<CfaDrizzleResult> perFrameResults = _seededPerFrameResults(
          width,
          height,
          frameCount,
          seed: 42,
        );

        // --- 全画像一括版を「正解」として計算 ---
        final CfaDrizzleResult reference = robustCombineCfaDrizzleResults(
          perFrameResults,
        );

        // --- タイル方式版(今回の実装) ---
        final List<LinearRgbTileStore> valueStores = <LinearRgbTileStore>[];
        final List<LinearRgbTileStore> coverageStores = <LinearRgbTileStore>[];
        for (final CfaDrizzleResult frame in perFrameResults) {
          final Float32List valueSamples = Float32List(width * height * 3);
          final Float32List coverageSamples = Float32List(
            width * height * 3,
          );
          for (int c = 0; c < 3; c++) {
            for (int i = 0; i < width * height; i++) {
              valueSamples[i * 3 + c] = frame.channels[c].value[i];
              coverageSamples[i * 3 + c] = frame.channels[c].coverage[i];
            }
          }
          valueStores.add(
            InMemoryRgbTileStore(
              width: width,
              height: height,
              interleavedRgb: valueSamples,
            ),
          );
          coverageStores.add(
            InMemoryRgbTileStore(
              width: width,
              height: height,
              interleavedRgb: coverageSamples,
            ),
          );
        }

        final ({
          LinearRgbTileStore valueStore,
          LinearRgbTileStore coverageStore,
        }) tiled = await robustCombineCfaDrizzleTiledResults(
          valueStores: valueStores,
          coverageStores: coverageStores,
          outputValueStoreFactory: RecordingRgbTileStoreFactory().call,
          outputCoverageStoreFactory: RecordingRgbTileStoreFactory().call,
          tileSize: tileSize,
        );

        final RecordingRgbTileStore recordedValue =
            tiled.valueStore as RecordingRgbTileStore;
        final RecordingRgbTileStore recordedCoverage =
            tiled.coverageStore as RecordingRgbTileStore;

        final Float32List tiledValue = Float32List(width * height * 3);
        for (final tile in recordedValue.writtenTiles) {
          for (int ly = 0; ly < tile.height; ly++) {
            for (int lx = 0; lx < tile.width; lx++) {
              final int gx = tile.x + lx;
              final int gy = tile.y + ly;
              for (int c = 0; c < 3; c++) {
                tiledValue[(gy * width + gx) * 3 + c] = tile.channelAt(
                  lx,
                  ly,
                  c,
                );
              }
            }
          }
        }
        final Float32List tiledCoverage = Float32List(width * height * 3);
        for (final tile in recordedCoverage.writtenTiles) {
          for (int ly = 0; ly < tile.height; ly++) {
            for (int lx = 0; lx < tile.width; lx++) {
              final int gx = tile.x + lx;
              final int gy = tile.y + ly;
              for (int c = 0; c < 3; c++) {
                tiledCoverage[(gy * width + gx) * 3 + c] = tile.channelAt(
                  lx,
                  ly,
                  c,
                );
              }
            }
          }
        }

        for (int c = 0; c < 3; c++) {
          for (int i = 0; i < width * height; i++) {
            expect(
              (tiledValue[i * 3 + c] - reference.channels[c].value[i]).abs(),
              lessThan(1e-5),
              reason: 'value mismatch at pixel $i channel $c '
                  '(tileSize=$tileSize)',
            );
            expect(
              (tiledCoverage[i * 3 + c] - reference.channels[c].coverage[i])
                  .abs(),
              lessThan(1e-5),
              reason: 'coverage mismatch at pixel $i channel $c '
                  '(tileSize=$tileSize)',
            );
          }
        }
      },
    );
  }

  test(
    'valueStoresとcoverageStoresの長さが異なると'
    'InvalidRobustCombineInputを投げる',
    () async {
      final LinearRgbTileStore a = InMemoryRgbTileStore(
        width: 4,
        height: 4,
        interleavedRgb: Float32List(4 * 4 * 3),
      );
      await expectLater(
        robustCombineCfaDrizzleTiledResults(
          valueStores: <LinearRgbTileStore>[a],
          coverageStores: const <LinearRgbTileStore>[],
          outputValueStoreFactory: RecordingRgbTileStoreFactory().call,
          outputCoverageStoreFactory: RecordingRgbTileStoreFactory().call,
        ),
        throwsA(isA<InvalidRobustCombineInput>()),
      );
    },
  );

  test('キャンセルされると両方の出力ストアがabortされる', () async {
    const int width = 8;
    const int height = 8;
    final LinearRgbTileStore valueStore = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List(width * height * 3),
    );
    final LinearRgbTileStore coverageStore = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List(width * height * 3),
    );
    final RecordingRgbTileStoreFactory valueFactory =
        RecordingRgbTileStoreFactory();
    final RecordingRgbTileStoreFactory coverageFactory =
        RecordingRgbTileStoreFactory();
    await expectLater(
      robustCombineCfaDrizzleTiledResults(
        valueStores: <LinearRgbTileStore>[valueStore],
        coverageStores: <LinearRgbTileStore>[coverageStore],
        outputValueStoreFactory: valueFactory.call,
        outputCoverageStoreFactory: coverageFactory.call,
        tileSize: 4,
        isCancelled: () => true,
      ),
      throwsA(isA<StateError>()),
    );
    expect(valueFactory.latest!.aborted, isTrue);
    expect(coverageFactory.latest!.aborted, isTrue);
  });
}
