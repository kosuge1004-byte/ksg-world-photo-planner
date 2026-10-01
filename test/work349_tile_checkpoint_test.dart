import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/linear_contribution_tile.dart';
import 'package:mobile_stack/core/session/milky_way_tile_combine_checkpoint.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

final plan = OverlappedTilePlan.create(
    imageWidth: 4, imageHeight: 2, tileSize: 2, overlap: 0);
Future<void> write(
    MilkyWayTileCombineCheckpointProgress p, int index, double value) async {
  final t = plan.tiles[index];
  await p.rgbStore.writeTile(LinearRgbTile(
      x: t.outputX,
      y: t.outputY,
      width: t.outputWidth,
      height: t.outputHeight,
      interleavedRgb: Float32List.fromList(
          List.filled(t.outputWidth * t.outputHeight * 3, value))));
  await p.contributionStore.writeTile(LinearContributionTile(
      x: t.outputX,
      y: t.outputY,
      width: t.outputWidth,
      height: t.outputHeight,
      interleavedCounts: Uint16List.fromList(
          List.filled(t.outputWidth * t.outputHeight * 3, index + 2))));
}

Future<void> close(MilkyWayTileCombineCheckpointProgress p) async {
  await p.rgbStore.closeRetainingFile();
  await p.contributionStore.closeRetainingFile();
}

void main() {
  late Directory directory;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('work349-checkpoint-');
  });
  tearDown(() async {
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
  });
  MilkyWayTileCombineCheckpointStore checkpoint(
          {String identity = 'original'}) =>
      MilkyWayTileCombineCheckpointStore(
          directory: directory, identity: identity)
        ..bindInputs({
          'transforms': [1, 0, 0, 0, 1, 0]
        });
  Future<MilkyWayTileCombineCheckpointProgress> open(
          MilkyWayTileCombineCheckpointStore c) =>
      c.openOrCreate(width: 4, height: 2, plan: plan);

  test(
      'reopen preserves both planes and resumes exact deterministic tile order',
      () async {
    final c = checkpoint();
    final p = await open(c);
    await write(p, 0, .25);
    await c.recordProgress(1);
    await close(p);
    final resumed = checkpoint();
    final r = await open(resumed);
    expect(r.resumeFromTileIndex, 1);
    await write(r, 1, .75);
    await resumed.recordProgress(2);
    await r.rgbStore.commit();
    await r.contributionStore.commit();
    final rgb = await r.rgbStore.readRegion(x: 0, y: 0, width: 4, height: 2);
    final counts =
        await r.contributionStore.readRegion(x: 0, y: 0, width: 4, height: 2);
    expect(rgb.channelAt(0, 0, 1), .25);
    expect(rgb.channelAt(3, 1, 1), .75);
    expect(counts.channelCountAt(0, 0, 1), 2);
    expect(counts.channelCountAt(3, 1, 1), 3);
    await close(r);
  });
  test('same-length pixel corruption is rejected', () async {
    final c = checkpoint();
    final p = await open(c);
    await write(p, 0, .25);
    await c.recordProgress(1);
    await close(p);
    final file = File('${directory.path}/combined.f32');
    final handle = await file.open(mode: FileMode.append);
    await handle.setPosition(0);
    await handle.writeByte(255);
    await handle.close();
    final r = await open(checkpoint());
    expect(r.resumeFromTileIndex, 0);
    await close(r);
  });
  test('changed input/settings identity cannot reuse prior tiles', () async {
    final c = checkpoint();
    final p = await open(c);
    await write(p, 0, .25);
    await c.recordProgress(1);
    await close(p);
    final r = await open(checkpoint(identity: 'changed'));
    expect(r.resumeFromTileIndex, 0);
    await close(r);
  });
  test('unpublished partial tile is recomputed', () async {
    final c = checkpoint();
    final p = await open(c);
    await write(p, 0, .25);
    await close(p);
    final r = await open(checkpoint());
    expect(r.resumeFromTileIndex, 0);
    await close(r);
  });
  test('damaged receipt chain cannot reuse tiles', () async {
    final c = checkpoint();
    final p = await open(c);
    await write(p, 0, .25);
    await c.recordProgress(1);
    await close(p);
    await File('${directory.path}/tile_0.json')
        .writeAsString('{}', flush: true);
    final r = await open(checkpoint());
    expect(r.resumeFromTileIndex, 0);
    await close(r);
  });
}
