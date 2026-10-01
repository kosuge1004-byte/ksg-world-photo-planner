import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/background/durable_decoded_frame_cache.dart';
import 'package:mobile_stack/core/image/file_backed_linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

void main() {
  test('restart accepts only published, hashed FP32 bytes', () async {
    final dir = await Directory.systemTemp.createTemp('decoded-cache-test-');
    final cache = DurableDecodedFrameCache(
        statusPath: '${dir.path}/status.json', identity: 'inputs-A');
    final plan = OverlappedTilePlan.create(
        imageWidth: 2, imageHeight: 2, tileSize: 2, overlap: 0);
    final store = await cache.create(index: 0, width: 2, height: 2, plan: plan);
    final values = Float32List.fromList(
        [-.03, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1.2, 2]);
    try {
      await store.writeTile(LinearRgbTile(
          x: 0, y: 0, width: 2, height: 2, interleavedRgb: values));
      await store.commit();
      expect(await cache.restore(0),
          isNull); // Preallocated data is not a receipt.
      await cache.publish(0, store);
      await (store as FileBackedLinearRgbTileStore).closeRetainingFile();
      final restarted = DurableDecodedFrameCache(
          statusPath: '${dir.path}/status.json', identity: 'inputs-A');
      final recovered = await restarted.restore(0);
      expect(recovered, isNotNull);
      expect(
          (await recovered!.readRegion(x: 0, y: 0, width: 2, height: 2))
              .interleavedRgb,
          values);
      await (recovered as FileBackedLinearRgbTileStore).closeRetainingFile();
      final wrongInputs = DurableDecodedFrameCache(
          statusPath: '${dir.path}/status.json', identity: 'inputs-B');
      expect(await wrongInputs.restore(0), isNull);
      final file = File(store.path);
      final bytes = await file.readAsBytes();
      bytes[0] ^= 1; // Same length and still a finite floating point value.
      await file.writeAsBytes(bytes, flush: true);
      expect(await restarted.restore(0), isNull);
    } finally {
      await store.dispose();
      await dir.delete(recursive: true);
    }
  });

  test('input hash detects replacement with identical length and timestamp',
      () async {
    final dir = await Directory.systemTemp.createTemp('input-identity-test-');
    try {
      final file = File('${dir.path}/input.dng');
      await file.writeAsBytes([1, 2, 3, 4]);
      final modified = await file.lastModified();
      Future<String> identity() => DurableDecodedFrameCache.buildIdentity(
          paths: [file.path], options: {'fadePercent': 15});
      final first = await identity();
      await file.writeAsBytes([4, 3, 2, 1]);
      await file.setLastModified(modified);
      expect(await identity(), isNot(first));
    } finally {
      await dir.delete(recursive: true);
    }
  });
}
