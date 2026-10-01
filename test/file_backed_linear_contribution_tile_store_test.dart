import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/file_backed_linear_contribution_tile_store.dart';
import 'package:mobile_stack/core/image/linear_contribution_tile.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

LinearContributionTile _counts(OverlappedTile tile, int value) =>
    LinearContributionTile(
      x: tile.outputX,
      y: tile.outputY,
      width: tile.outputWidth,
      height: tile.outputHeight,
      interleavedCounts: Uint16List.fromList(
        List<int>.filled(tile.outputWidth * tile.outputHeight * 3, value),
      ),
    );

void main() {
  test('計画順のuint16 RGB countをcommit後に領域読込できる', () async {
    final OverlappedTilePlan plan = OverlappedTilePlan.create(
      imageWidth: 3,
      imageHeight: 2,
      tileSize: 2,
      overlap: 0,
    );
    final FileBackedLinearContributionTileStore store =
        await FileBackedLinearContributionTileStore.createTemporary(
      width: 3,
      height: 2,
      plan: plan,
    );
    final String path = store.path;
    expect(store.persistentByteLength, 3 * 2 * 3 * 2);
    for (int index = 0; index < plan.tiles.length; index++) {
      await store.writeTile(_counts(plan.tiles[index], index + 1));
    }
    await store.commit();

    final LinearContributionTile full = await store.readRegion(
      x: 0,
      y: 0,
      width: 3,
      height: 2,
    );
    expect(full.channelCountAt(0, 0, 0), 1);
    expect(full.channelCountAt(2, 1, 2), 2);
    await store.dispose();
    expect(File(path).existsSync(), isFalse);
  });

  test('未完了commitと計画外順序を拒否してabortで削除する', () async {
    final OverlappedTilePlan plan = OverlappedTilePlan.create(
      imageWidth: 3,
      imageHeight: 2,
      tileSize: 2,
      overlap: 0,
    );
    final FileBackedLinearContributionTileStore store =
        await FileBackedLinearContributionTileStore.createTemporary(
      width: 3,
      height: 2,
      plan: plan,
    );
    final String path = store.path;

    await expectLater(store.commit(), throwsStateError);
    await expectLater(
        store.writeTile(_counts(plan.tiles[1], 1)), throwsStateError);
    await store.abort();
    expect(File(path).existsSync(), isFalse);
  });

  test('commit前の読込とcommit後の追記を拒否する', () async {
    final OverlappedTilePlan plan = OverlappedTilePlan.create(
      imageWidth: 2,
      imageHeight: 2,
      tileSize: 2,
      overlap: 0,
    );
    final FileBackedLinearContributionTileStore store =
        await FileBackedLinearContributionTileStore.createTemporary(
      width: 2,
      height: 2,
      plan: plan,
    );
    await expectLater(
      store.readRegion(x: 0, y: 0, width: 1, height: 1),
      throwsStateError,
    );
    await store.writeTile(_counts(plan.tiles.single, 3));
    await store.commit();
    await expectLater(
      store.writeTile(_counts(plan.tiles.single, 3)),
      throwsStateError,
    );
    await store.dispose();
  });
}
