import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/file_backed_linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

LinearRgbTile _tileFor(OverlappedTile tile, int imageWidth) {
  final Float32List samples =
      Float32List(tile.outputWidth * tile.outputHeight * 3);
  for (int localY = 0; localY < tile.outputHeight; localY++) {
    for (int localX = 0; localX < tile.outputWidth; localX++) {
      final int globalX = tile.outputX + localX;
      final int globalY = tile.outputY + localY;
      final int base = (localY * tile.outputWidth + localX) * 3;
      final int pixel = globalY * imageWidth + globalX;
      samples[base] = pixel * 10;
      samples[base + 1] = pixel * 10 + 1;
      samples[base + 2] = pixel * 10 + 2;
    }
  }
  return LinearRgbTile(
    x: tile.outputX,
    y: tile.outputY,
    width: tile.outputWidth,
    height: tile.outputHeight,
    interleavedRgb: samples,
  );
}

void main() {
  test('タイルを全画面RAM化せずファイルへ書いて部分読出しする', () async {
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-rgb-tiles-');
    final String path =
        '${directory.path}${Platform.pathSeparator}linear-rgb.f32';
    final OverlappedTilePlan plan = OverlappedTilePlan.create(
      imageWidth: 4,
      imageHeight: 3,
      tileSize: 2,
      overlap: 0,
    );
    final FileBackedLinearRgbTileStore store =
        await FileBackedLinearRgbTileStore.create(
      path: path,
      width: 4,
      height: 3,
      plan: plan,
    );
    try {
      for (final OverlappedTile tile in plan.tiles) {
        await store.writeTile(_tileFor(tile, 4));
      }
      await store.commit();

      expect(store.isCommitted, isTrue);
      expect(store.completedTileCount, plan.tiles.length);
      expect(store.persistentByteLength, 4 * 3 * 3 * 4);
      expect(await File(path).length(), 4 * 3 * 3 * 4);

      final LinearRgbTile region = await store.readRegion(
        x: 1,
        y: 1,
        width: 2,
        height: 2,
      );
      expect(region.channelAt(0, 0, 0), 50);
      expect(region.channelAt(0, 0, 1), 51);
      expect(region.channelAt(1, 0, 2), 62);
      expect(region.channelAt(0, 1, 0), 90);
      expect(region.channelAt(1, 1, 2), 102);
    } finally {
      await store.dispose();
      expect(await File(path).exists(), isFalse);
      await directory.delete(recursive: true);
    }
  });

  test('未完了タイル集合をコミットせず中断時に削除する', () async {
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-rgb-abort-');
    final String path = '${directory.path}${Platform.pathSeparator}partial.f32';
    final OverlappedTilePlan plan = OverlappedTilePlan.create(
      imageWidth: 4,
      imageHeight: 3,
      tileSize: 2,
      overlap: 0,
    );
    final FileBackedLinearRgbTileStore store =
        await FileBackedLinearRgbTileStore.create(
      path: path,
      width: 4,
      height: 3,
      plan: plan,
    );
    try {
      await store.writeTile(_tileFor(plan.tiles.first, 4));
      await expectLater(store.commit(), throwsStateError);
      await store.abort();
      expect(await File(path).exists(), isFalse);
    } finally {
      await store.dispose();
      await directory.delete(recursive: true);
    }
  });

  test('計画順でないタイル書込みを拒否する', () async {
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-rgb-order-');
    final String path = '${directory.path}${Platform.pathSeparator}ordered.f32';
    final OverlappedTilePlan plan = OverlappedTilePlan.create(
      imageWidth: 4,
      imageHeight: 3,
      tileSize: 2,
      overlap: 0,
    );
    final FileBackedLinearRgbTileStore store =
        await FileBackedLinearRgbTileStore.create(
      path: path,
      width: 4,
      height: 3,
      plan: plan,
    );
    try {
      await expectLater(
        store.writeTile(_tileFor(plan.tiles[1], 4)),
        throwsStateError,
      );
    } finally {
      await store.abort();
      await directory.delete(recursive: true);
    }
  });

  test('所有する一時ディレクトリもdisposeで削除する', () async {
    final OverlappedTilePlan plan = OverlappedTilePlan.create(
      imageWidth: 1,
      imageHeight: 1,
      tileSize: 1,
      overlap: 0,
    );
    final FileBackedLinearRgbTileStore store =
        await FileBackedLinearRgbTileStore.createTemporary(
      width: 1,
      height: 1,
      plan: plan,
    );
    final Directory ownedDirectory = File(store.path).parent;
    expect(await ownedDirectory.exists(), isTrue);

    await store.dispose();

    expect(await ownedDirectory.exists(), isFalse);
  });
}
