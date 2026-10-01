import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/local_tone_adaptation.dart';
import 'package:mobile_stack/core/export/tiled_local_tone_adaptation.dart';
import 'package:mobile_stack/core/image/file_backed_linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

void main() {
  test('Work304 streamed local tone matches whole-frame reference', () async {
    const int width = 7;
    const int height = 5;
    final Float32List rgb = Float32List(width * height * 3);
    for (int i = 0; i < rgb.length; i++) {
      rgb[i] = ((i * 17 + 3) % 101) / 37.0 - 0.25;
    }

    final OverlappedTilePlan inputPlan = OverlappedTilePlan.create(
      imageWidth: width,
      imageHeight: height,
      tileSize: width,
      overlap: 0,
    );
    final FileBackedLinearRgbTileStore input =
        await FileBackedLinearRgbTileStore.createTemporary(
      width: width,
      height: height,
      plan: inputPlan,
    );
    await input.writeTile(
      LinearRgbTile(
        x: 0,
        y: 0,
        width: width,
        height: height,
        interleavedRgb: rgb,
      ),
    );
    await input.commit();

    final Float32List expected = applyLocalToneAdaptation(
      rgb,
      width,
      height,
      blurRadius: 2,
      strength: 0.47,
      referencePercentile: 0.83,
      minGain: 0.25,
      maxGain: 4,
      epsilon: 1e-6,
    );

    final LinearRgbTileStore actualStore = await applyLocalToneAdaptationTiled(
      inputStore: input,
      outputStoreFactory: ({
        required int width,
        required int height,
        required OverlappedTilePlan plan,
      }) =>
          FileBackedLinearRgbTileStore.createTemporary(
        width: width,
        height: height,
        plan: plan,
      ),
      tileSize: 3,
      stripHeight: 2,
      blurRadius: 2,
      strength: 0.47,
      referencePercentile: 0.83,
      minGain: 0.25,
      maxGain: 4,
      epsilon: 1e-6,
    );

    try {
      final LinearRgbTile actual = await actualStore.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      expect(actual.interleavedRgb, orderedEquals(expected));
    } finally {
      await actualStore.dispose();
      await input.dispose();
    }
  });
}
