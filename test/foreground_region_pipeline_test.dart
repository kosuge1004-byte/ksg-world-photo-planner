import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/session/star_trail_pipeline.dart';
import 'package:mobile_stack/core/stacking/foreground_region.dart';

import 'support/in_memory_rgb_tile_store.dart';
import 'support/recording_rgb_tile_store.dart';

void main() {
  test('foreground halo gives tile-independent pixels and leaves sky bit exact',
      () async {
    const width = 73, height = 61;
    final rgb = Float32List(width * height * 3);
    final ref = Float32List(width * height * 3);
    for (int i = 0; i < width * height; i++) {
      rgb[i * 3] = .3 + (i % 7) * .002;
      rgb[i * 3 + 1] = .4;
      rgb[i * 3 + 2] = .5;
      ref[i * 3] = -.03;
      ref[i * 3 + 1] = .05;
      ref[i * 3 + 2] = .06;
    }
    final combined =
        InMemoryRgbTileStore(width: width, height: height, interleavedRgb: rgb);
    final reference =
        InMemoryRgbTileStore(width: width, height: height, interleavedRgb: ref);
    final region = ForegroundRegion([
      [(x: 0.0, y: .5), (x: 1.0, y: .5), (x: 1.0, y: 1.0), (x: 0.0, y: 1.0)]
    ]);
    final whole = LinearRgbTile(
        x: 0, y: 0, width: width, height: height, interleavedRgb: rgb);
    final mask = region.weights(whole, width, height);
    Float32List? first;
    for (final tileSize in [7, 16, 31, 128]) {
      final factory = RecordingRgbTileStoreFactory();
      final store = await applyStarTrailReferenceForegroundToStore(
          combinedStore: combined,
          referenceStore: reference,
          foregroundRegion: region,
          outputStoreFactory: factory.call,
          tileSize: tileSize);
      final actual =
          (await store.readRegion(x: 0, y: 0, width: width, height: height))
              .interleavedRgb;
      for (int i = 0; i < mask.length; i++) {
        if (mask[i] == 0) {
          expect(
              actual.sublist(i * 3, i * 3 + 3), rgb.sublist(i * 3, i * 3 + 3));
        }
      }
      if (first == null) {
        first = actual;
      } else {
        expect(actual, first);
      }
      expect(actual[(height - 10) * width * 3 + 30 * 3], closeTo(-.03, 1e-6));
      expect(actual[31 * width * 3 + 30 * 3],
          greaterThan(-.03)); // Feather retains intermediate values.
      await store.dispose();
    }
  });
}
