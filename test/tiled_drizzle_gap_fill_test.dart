import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/drizzle_accumulator.dart';
import 'package:mobile_stack/core/drizzle/drizzle_gap_fill.dart';
import 'package:mobile_stack/core/drizzle/tiled_drizzle_gap_fill.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';

import 'support/in_memory_rgb_tile_store.dart';
import 'support/recording_rgb_tile_store.dart';

/// The key correctness check for `tiled_drizzle_gap_fill.dart`: confirms
/// the tiled, region-margin-based restructuring produces numerically
/// identical results to the already-tested whole-image
/// `fillChannelGaps` (Work91) on the same synthetic value/coverage data
/// — the same "tiled version matches the whole-frame version exactly"
/// discipline established for `tiled_cfa_drizzle.dart` (Work87).

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

/// A tiny helper wrapping [fillChannelGaps]'s three-channel application
/// over interleaved RGB samples (matching how [LinearRgbTileStore]
/// stores value/coverage as three parallel scalar channels — see
/// `tiled_cfa_drizzle.dart`'s own doc comment for why), used only to
/// compute this test's own "expected" reference values, independent of
/// `tiled_drizzle_gap_fill.dart`'s own tiled logic.
class _DrizzleResultLike {
  _DrizzleResultLike(this._channelResults);

  final List<DrizzleResult> _channelResults;

  double valueAt(int flatIndex, int channel) =>
      _channelResults[channel].value[flatIndex];
}

DrizzleResult _extractChannel(
  int width,
  int height,
  Float32List valueSamples,
  Float32List coverageSamples,
  int channel,
) {
  final Float64List value = Float64List(width * height);
  final Float64List coverage = Float64List(width * height);
  for (int i = 0; i < width * height; i++) {
    value[i] = valueSamples[i * 3 + channel];
    coverage[i] = coverageSamples[i * 3 + channel];
  }
  return DrizzleResult(
    width: width,
    height: height,
    value: value,
    coverage: coverage,
  );
}

_DrizzleResultLike _wholeImageReference(
  int width,
  int height,
  Float32List valueSamples,
  Float32List coverageSamples,
) {
  final List<DrizzleResult> results = <DrizzleResult>[
    for (int c = 0; c < 3; c++)
      fillChannelGaps(
        _extractChannel(width, height, valueSamples, coverageSamples, c),
        width,
        height,
      ),
  ];
  return _DrizzleResultLike(results);
}

void main() {
  for (final int tileSize in <int>[4, 7, 100]) {
    test(
      'タイルサイズ=$tileSizeでの結果が、全画像一括版のfillChannelGapsと'
      '数値的に一致する',
      () async {
        const int width = 16;
        const int height = 12;

        // coverageの約半分をギャップ(0)にし、残りは疎らな正のcoverageに
        // する(実際のdrizzle出力に近い、不規則な疎密パターンを模す)。
        final Float32List valueSamples = _seededSamples(
          width,
          height,
          7,
          10,
        );
        final Float32List coverageRaw = _seededSamples(width, height, 13, 1);
        final Float32List coverageSamples = Float32List(coverageRaw.length);
        for (int i = 0; i < coverageRaw.length; i++) {
          coverageSamples[i] = coverageRaw[i] < 0.5 ? 0 : coverageRaw[i];
        }

        final InMemoryRgbTileStore valueStore = InMemoryRgbTileStore(
          width: width,
          height: height,
          interleavedRgb: valueSamples,
        );
        final InMemoryRgbTileStore coverageStore = InMemoryRgbTileStore(
          width: width,
          height: height,
          interleavedRgb: coverageSamples,
        );

        // --- 全画像一括版(Work91、既に検証済み)を「正解」として計算 ---
        final _DrizzleResultLike reference = _wholeImageReference(
          width,
          height,
          valueSamples,
          coverageSamples,
        );

        // --- タイル方式版(今回の実装) ---
        final RecordingRgbTileStoreFactory outputFactory =
            RecordingRgbTileStoreFactory();
        final LinearRgbTileStore result = await fillDrizzleTiledGaps(
          valueStore: valueStore,
          coverageStore: coverageStore,
          outputStoreFactory: outputFactory.call,
          tileSize: tileSize,
        );
        final RecordingRgbTileStore recordedResult =
            result as RecordingRgbTileStore;

        final Float32List tiledValue = Float32List(width * height * 3);
        for (final LinearRgbTile tile in recordedResult.writtenTiles) {
          for (int ly = 0; ly < tile.height; ly++) {
            for (int lx = 0; lx < tile.width; lx++) {
              final int gx = tile.x + lx;
              final int gy = tile.y + ly;
              for (int c = 0; c < 3; c++) {
                tiledValue[(gy * width + gx) * 3 + c] =
                    tile.channelAt(lx, ly, c);
              }
            }
          }
        }

        for (int c = 0; c < 3; c++) {
          for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
              final int index = y * width + x;
              final double refValue = reference.valueAt(index, c);
              final double tiledValueAt = tiledValue[index * 3 + c];
              expect(
                (tiledValueAt - refValue).abs(),
                lessThan(1e-5),
                reason: 'mismatch at channel $c, ($x,$y): '
                    'tiled=$tiledValueAt ref=$refValue (tileSize=$tileSize)',
              );
            }
          }
        }
      },
    );
  }

  test(
    'valueStoreとcoverageStoreの寸法が異なるとInvalidGapFillInputを'
    '投げる',
    () async {
      final InMemoryRgbTileStore valueStore = InMemoryRgbTileStore(
        width: 4,
        height: 4,
        interleavedRgb: Float32List(4 * 4 * 3),
      );
      final InMemoryRgbTileStore coverageStore = InMemoryRgbTileStore(
        width: 5,
        height: 5,
        interleavedRgb: Float32List(5 * 5 * 3),
      );
      await expectLater(
        fillDrizzleTiledGaps(
          valueStore: valueStore,
          coverageStore: coverageStore,
          outputStoreFactory: RecordingRgbTileStoreFactory().call,
        ),
        throwsA(isA<InvalidGapFillInput>()),
      );
    },
  );

  test('kernelRadiusが1未満だとInvalidGapFillInputを投げる', () async {
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: 4,
      height: 4,
      interleavedRgb: Float32List(4 * 4 * 3),
    );
    await expectLater(
      fillDrizzleTiledGaps(
        valueStore: store,
        coverageStore: store,
        outputStoreFactory: RecordingRgbTileStoreFactory().call,
        kernelRadius: 0,
      ),
      throwsA(isA<InvalidGapFillInput>()),
    );
  });

  test('キャンセルされると出力ストアがabortされる', () async {
    const int width = 8;
    const int height = 8;
    final InMemoryRgbTileStore valueStore = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: _seededSamples(width, height, 1, 5),
    );
    final InMemoryRgbTileStore coverageStore = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: _seededSamples(width, height, 2, 3),
    );
    final RecordingRgbTileStoreFactory outputFactory =
        RecordingRgbTileStoreFactory();
    await expectLater(
      fillDrizzleTiledGaps(
        valueStore: valueStore,
        coverageStore: coverageStore,
        outputStoreFactory: outputFactory.call,
        tileSize: 4,
        isCancelled: () => true,
      ),
      throwsA(isA<StateError>()),
    );
    expect(outputFactory.latest!.aborted, isTrue);
  });
}
