import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/cfa_drizzle.dart';
import 'package:mobile_stack/core/drizzle/tiled_cfa_drizzle.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_raw_mosaic_store.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/registration/similarity_transform_math.dart';

import 'support/recording_rgb_tile_store.dart';

/// The key correctness check for `tiled_cfa_drizzle.dart`: confirms the
/// tiled, file-backed restructuring produces numerically identical
/// results (within floating-point tolerance) to the already-tested
/// whole-frame `cfaDrizzle` (Work85) on the same synthetic input, rather
/// than re-verifying the splatting mathematics itself a second time from
/// scratch. Run at more than one tile size specifically to exercise the
/// tile-boundary behavior — a bug in the tiling restructuring (as
/// opposed to the shared splatting math both versions delegate to
/// `DrizzleAccumulator` for) would most likely show up exactly at tile
/// seams.

final class _Estimate implements SimilarityTransformEstimate {
  const _Estimate({
    required this.rotationDegrees,
    required this.sourceOffsetX,
    required this.sourceOffsetY,
    required this.centerX,
    required this.centerY,
  });

  @override
  final double rotationDegrees;
  @override
  final double sourceOffsetX;
  @override
  final double sourceOffsetY;
  @override
  final double centerX;
  @override
  final double centerY;
}

Float32List _seededSamples(int width, int height, int seed) {
  final Float32List samples = Float32List(width * height);
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  for (int i = 0; i < samples.length; i++) {
    samples[i] = next() * 10; // typical linear-light-ish magnitude
  }
  return samples;
}

void main() {
  for (final int tileSize in <int>[4, 6, 100]) {
    test(
      'タイルサイズ=$tileSizeでの結果が、全フレーム一括版のcfaDrizzleと'
      '数値的に一致する(identity + 回転フレームの混在)',
      () async {
        const int width = 12;
        const int height = 10;
        const double outputScale = 2;
        final int outputWidth = width * outputScale.toInt();
        final int outputHeight = height * outputScale.toInt();
        const double pixfrac = 0.8;

        final Float32List samplesA = _seededSamples(width, height, 11);
        final Float32List samplesB = _seededSamples(width, height, 22);

        const _Estimate estimateB = _Estimate(
          rotationDegrees: 8,
          sourceOffsetX: 0.6,
          sourceOffsetY: -0.3,
          centerX: width / 2,
          centerY: height / 2,
        );

        // --- 全フレーム一括版(Work85, 既に検証済み)を「正解」として計算 ---
        final CfaDrizzleResult reference = cfaDrizzle(
          frames: <CfaDrizzleFrame>[
            CfaDrizzleFrame(
              width: width,
              height: height,
              cfaPattern: CfaPattern.rggb,
              samples: samplesA,
              forwardTransform: (double x, double y) => (x: x, y: y),
            ),
            CfaDrizzleFrame(
              width: width,
              height: height,
              cfaPattern: CfaPattern.rggb,
              samples: samplesB,
              forwardTransform: invertSimilarityTransform(estimateB),
            ),
          ],
          outputWidth: outputWidth,
          outputHeight: outputHeight,
          outputScale: outputScale,
          pixfrac: pixfrac,
        );

        // --- タイル方式版(今回の実装)で同じ入力を計算 ---
        final FileBackedLinearRawMosaicStore storeA =
            await FileBackedLinearRawMosaicStore.createTemporary(
          width: width,
          height: height,
          cfaPattern: CfaPattern.rggb,
        );
        final FileBackedLinearRawMosaicStore storeB =
            await FileBackedLinearRawMosaicStore.createTemporary(
          width: width,
          height: height,
          cfaPattern: CfaPattern.rggb,
        );
        try {
          await storeA.writeFull(
            LinearRawMosaic(
              width: width,
              height: height,
              cfaPattern: CfaPattern.rggb,
              samples: samplesA,
            ),
          );
          await storeB.writeFull(
            LinearRawMosaic(
              width: width,
              height: height,
              cfaPattern: CfaPattern.rggb,
              samples: samplesB,
            ),
          );

          final RecordingRgbTileStoreFactory valueFactory =
              RecordingRgbTileStoreFactory();
          final RecordingRgbTileStoreFactory coverageFactory =
              RecordingRgbTileStoreFactory();

          final CfaDrizzleTiledResult tiled = await drizzleCfaTiled(
            frames: <CfaDrizzleTiledFrame>[
              CfaDrizzleTiledFrame(mosaicStore: storeA),
              CfaDrizzleTiledFrame(
                mosaicStore: storeB,
                transformEstimate: estimateB,
              ),
            ],
            outputWidth: outputWidth,
            outputHeight: outputHeight,
            valueStoreFactory: valueFactory.call,
            coverageStoreFactory: coverageFactory.call,
            tileSize: tileSize,
            outputScale: outputScale,
            pixfrac: pixfrac,
          );

          final RecordingRgbTileStore valueStore =
              tiled.valueStore as RecordingRgbTileStore;
          final RecordingRgbTileStore coverageStore =
              tiled.coverageStore as RecordingRgbTileStore;

          // 書き込まれた全タイルを、絶対座標のフラットな配列へ再構成する。
          final Float32List tiledValue = Float32List(
            outputWidth * outputHeight * 3,
          );
          final Float32List tiledCoverage = Float32List(
            outputWidth * outputHeight * 3,
          );
          for (final tile in valueStore.writtenTiles) {
            for (int ly = 0; ly < tile.height; ly++) {
              for (int lx = 0; lx < tile.width; lx++) {
                final int gx = tile.x + lx;
                final int gy = tile.y + ly;
                for (int c = 0; c < 3; c++) {
                  tiledValue[(gy * outputWidth + gx) * 3 + c] =
                      tile.channelAt(lx, ly, c);
                }
              }
            }
          }
          for (final tile in coverageStore.writtenTiles) {
            for (int ly = 0; ly < tile.height; ly++) {
              for (int lx = 0; lx < tile.width; lx++) {
                final int gx = tile.x + lx;
                final int gy = tile.y + ly;
                for (int c = 0; c < 3; c++) {
                  tiledCoverage[(gy * outputWidth + gx) * 3 + c] =
                      tile.channelAt(lx, ly, c);
                }
              }
            }
          }

          // 参照実装(チャンネルごとのflat配列)と突き合わせる。
          for (int c = 0; c < 3; c++) {
            for (int y = 0; y < outputHeight; y++) {
              for (int x = 0; x < outputWidth; x++) {
                final int flatIndex = y * outputWidth + x;
                final double refValue = reference.channels[c].value[flatIndex];
                final double refCoverage =
                    reference.channels[c].coverage[flatIndex];
                final double tiledValueAt = tiledValue[flatIndex * 3 + c];
                final double tiledCoverageAt = tiledCoverage[flatIndex * 3 + c];
                expect(
                  (tiledValueAt - refValue).abs(),
                  lessThan(1e-5),
                  reason: 'value mismatch at channel $c, ($x,$y): '
                      'tiled=$tiledValueAt ref=$refValue '
                      '(tileSize=$tileSize)',
                );
                expect(
                  (tiledCoverageAt - refCoverage).abs(),
                  lessThan(1e-6),
                  reason: 'coverage mismatch at channel $c, ($x,$y): '
                      'tiled=$tiledCoverageAt ref=$refCoverage '
                      '(tileSize=$tileSize)',
                );
              }
            }
          }
        } finally {
          await storeA.dispose();
          await storeB.dispose();
        }
      },
    );
  }

  test('空のフレームリストはArgumentErrorを投げる', () async {
    await expectLater(
      drizzleCfaTiled(
        frames: const <CfaDrizzleTiledFrame>[],
        outputWidth: 4,
        outputHeight: 4,
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test('Bayer phase scale is applied lazily without changing coverage',
      () async {
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await store.writeFull(
        LinearRawMosaic(
          width: 2,
          height: 2,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List.fromList(<double>[1, 2, 3, 4]),
        ),
      );
      final RecordingRgbTileStoreFactory values =
          RecordingRgbTileStoreFactory();
      final RecordingRgbTileStoreFactory coverage =
          RecordingRgbTileStoreFactory();
      await drizzleCfaTiled(
        frames: <CfaDrizzleTiledFrame>[
          CfaDrizzleTiledFrame(
            mosaicStore: store,
            phaseScales: const <double>[2, 3, 4, 5],
          ),
        ],
        outputWidth: 2,
        outputHeight: 2,
        outputScale: 1,
        pixfrac: 1,
        tileSize: 2,
        valueStoreFactory: values.call,
        coverageStoreFactory: coverage.call,
      );
      final Float32List rgb =
          (await values.latest!.readRegion(x: 0, y: 0, width: 2, height: 2))
              .interleavedRgb;
      final Float32List weights =
          (await coverage.latest!.readRegion(x: 0, y: 0, width: 2, height: 2))
              .interleavedRgb;
      expect(rgb[0], closeTo(2, 1e-6));
      expect(rgb[4], closeTo(6, 1e-6));
      expect(rgb[7], closeTo(12, 1e-6));
      expect(rgb[11], closeTo(20, 1e-6));
      expect(weights.where((double value) => value > 0), everyElement(1));
    } finally {
      await store.dispose();
    }
  });

  test('pixfracまたはoutputScaleが非正だとArgumentErrorを投げる', () async {
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: 4,
      height: 4,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await store.writeFull(
        LinearRawMosaic(
          width: 4,
          height: 4,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List(16),
        ),
      );
      await expectLater(
        drizzleCfaTiled(
          frames: <CfaDrizzleTiledFrame>[
            CfaDrizzleTiledFrame(mosaicStore: store),
          ],
          outputWidth: 8,
          outputHeight: 8,
          valueStoreFactory: RecordingRgbTileStoreFactory().call,
          coverageStoreFactory: RecordingRgbTileStoreFactory().call,
          pixfrac: 0,
        ),
        throwsA(isA<ArgumentError>()),
      );
      await expectLater(
        drizzleCfaTiled(
          frames: <CfaDrizzleTiledFrame>[
            CfaDrizzleTiledFrame(mosaicStore: store),
          ],
          outputWidth: 8,
          outputHeight: 8,
          valueStoreFactory: RecordingRgbTileStoreFactory().call,
          coverageStoreFactory: RecordingRgbTileStoreFactory().call,
          outputScale: -1,
        ),
        throwsA(isA<ArgumentError>()),
      );
    } finally {
      await store.dispose();
    }
  });

  test('キャンセルされると出力ストアがabortされる', () async {
    const int width = 8;
    const int height = 8;
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await store.writeFull(
        LinearRawMosaic(
          width: width,
          height: height,
          cfaPattern: CfaPattern.rggb,
          samples: _seededSamples(width, height, 3),
        ),
      );
      final RecordingRgbTileStoreFactory valueFactory =
          RecordingRgbTileStoreFactory();
      final RecordingRgbTileStoreFactory coverageFactory =
          RecordingRgbTileStoreFactory();
      await expectLater(
        drizzleCfaTiled(
          frames: <CfaDrizzleTiledFrame>[
            CfaDrizzleTiledFrame(mosaicStore: store),
          ],
          outputWidth: width * 2,
          outputHeight: height * 2,
          valueStoreFactory: valueFactory.call,
          coverageStoreFactory: coverageFactory.call,
          tileSize: 4, // 複数タイルへ分割してキャンセルの機会を作る
          isCancelled: () => true,
        ),
        throwsA(isA<CfaDrizzleTiledCancelled>()),
      );
      expect(valueFactory.latest!.aborted, isTrue);
      expect(coverageFactory.latest!.aborted, isTrue);
    } finally {
      await store.dispose();
    }
  });
}
