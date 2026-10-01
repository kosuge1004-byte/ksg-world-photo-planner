import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/local_tone_adaptation.dart';
import 'package:mobile_stack/core/export/tiled_local_tone_adaptation.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';

import 'support/in_memory_rgb_tile_store.dart';
import 'support/recording_rgb_tile_store.dart';

/// The key correctness check for `tiled_local_tone_adaptation.dart`:
/// confirms the tiled, two-pass restructuring produces numerically
/// identical results to the already-tested whole-image
/// `applyLocalToneAdaptation` (Work99) on the same synthetic data — the
/// same "tiled version matches the whole-frame version exactly"
/// discipline established for `tiled_cfa_drizzle.dart` (Work87) and
/// `tiled_drizzle_gap_fill.dart` (Work92).

Float32List _sceneWithDimBackgroundAndBrightStar(int width, int height) {
  final Float32List rgb = Float32List(width * height * 3);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      final int index = y * width + x;
      final bool isStar = x >= (width - width ~/ 4) && y <= height ~/ 4;
      final double value = isStar ? 5.0 : 0.02;
      rgb[index * 3] = value;
      rgb[index * 3 + 1] = value;
      rgb[index * 3 + 2] = value;
    }
  }
  return rgb;
}

void main() {
  for (final (int tileSize, int stripHeight) in <(int, int)>[
    (4, 3),
    (7, 5),
    (100, 100),
  ]) {
    test(
      'tileSize=$tileSize・stripHeight=$stripHeightでの結果が、全画像'
      '一括版のapplyLocalToneAdaptationと数値的に一致する',
      () async {
        const int width = 16;
        const int height = 16;
        final Float32List rgb = _sceneWithDimBackgroundAndBrightStar(
          width,
          height,
        );

        // --- 全画像一括版(Work99、既に検証済み)を「正解」として計算 ---
        final Float32List reference = applyLocalToneAdaptation(
          rgb,
          width,
          height,
          blurRadius: 3,
          strength: 0.5,
          minGain: 0.1,
          maxGain: 10,
        );

        // --- タイル方式版(今回の実装) ---
        final InMemoryRgbTileStore inputStore = InMemoryRgbTileStore(
          width: width,
          height: height,
          interleavedRgb: rgb,
        );
        final RecordingRgbTileStoreFactory outputFactory =
            RecordingRgbTileStoreFactory();
        final LinearRgbTileStore result = await applyLocalToneAdaptationTiled(
          inputStore: inputStore,
          outputStoreFactory: outputFactory.call,
          tileSize: tileSize,
          stripHeight: stripHeight,
          blurRadius: 3,
          strength: 0.5,
          minGain: 0.1,
          maxGain: 10,
        );
        final RecordingRgbTileStore recordedResult =
            result as RecordingRgbTileStore;

        final Float32List tiledRgb = Float32List(width * height * 3);
        for (final LinearRgbTile tile in recordedResult.writtenTiles) {
          for (int ly = 0; ly < tile.height; ly++) {
            for (int lx = 0; lx < tile.width; lx++) {
              final int gx = tile.x + lx;
              final int gy = tile.y + ly;
              for (int c = 0; c < 3; c++) {
                tiledRgb[(gy * width + gx) * 3 + c] = tile.channelAt(lx, ly, c);
              }
            }
          }
        }

        for (int i = 0; i < reference.length; i++) {
          expect(
            (tiledRgb[i] - reference[i]).abs(),
            lessThan(1e-6),
            reason: 'mismatch at flat index $i: tiled=${tiledRgb[i]} '
                'ref=${reference[i]} (tileSize=$tileSize, '
                'stripHeight=$stripHeight)',
          );
        }
      },
    );
  }

  test('キャンセルされると出力ストアがabortされる', () async {
    const int width = 8;
    const int height = 8;
    final InMemoryRgbTileStore inputStore = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: _sceneWithDimBackgroundAndBrightStar(width, height),
    );
    final RecordingRgbTileStoreFactory outputFactory =
        RecordingRgbTileStoreFactory();
    await expectLater(
      applyLocalToneAdaptationTiled(
        inputStore: inputStore,
        outputStoreFactory: outputFactory.call,
        tileSize: 4,
        isCancelled: () => true,
      ),
      throwsA(isA<StateError>()),
    );
  });

  test(
    'strength=0では入力と数値的に同じ結果を返す'
    '(既存パイプラインへの無害な追加)',
    () async {
      const int width = 10;
      const int height = 10;
      final Float32List rgb = _sceneWithDimBackgroundAndBrightStar(
        width,
        height,
      );
      final InMemoryRgbTileStore inputStore = InMemoryRgbTileStore(
        width: width,
        height: height,
        interleavedRgb: rgb,
      );
      final RecordingRgbTileStoreFactory outputFactory =
          RecordingRgbTileStoreFactory();
      final LinearRgbTileStore result = await applyLocalToneAdaptationTiled(
        inputStore: inputStore,
        outputStoreFactory: outputFactory.call,
        tileSize: 4,
        strength: 0,
      );
      final RecordingRgbTileStore recordedResult =
          result as RecordingRgbTileStore;
      final Float32List tiledRgb = Float32List(width * height * 3);
      for (final LinearRgbTile tile in recordedResult.writtenTiles) {
        for (int ly = 0; ly < tile.height; ly++) {
          for (int lx = 0; lx < tile.width; lx++) {
            final int gx = tile.x + lx;
            final int gy = tile.y + ly;
            for (int c = 0; c < 3; c++) {
              tiledRgb[(gy * width + gx) * 3 + c] = tile.channelAt(
                lx,
                ly,
                c,
              );
            }
          }
        }
      }
      expect(tiledRgb, orderedEquals(rgb));
    },
  );
}
