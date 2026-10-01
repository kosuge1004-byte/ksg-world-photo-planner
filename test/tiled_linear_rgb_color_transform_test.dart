import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/color/linear_rgb_color_transform.dart';
import 'package:mobile_stack/core/color/tiled_linear_rgb_color_transform.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';

import 'support/in_memory_rgb_tile_store.dart';
import 'support/recording_rgb_tile_store.dart';

void main() {
  test('tiled transform exactly matches whole-buffer transform', () async {
    const int width = 9;
    const int height = 7;
    final Float32List rgb = Float32List(width * height * 3);
    for (int index = 0; index < rgb.length; index++) {
      rgb[index] = (index - 20) / 17;
    }
    final LinearRgbColorTransform transform = LinearRgbColorTransform(
      matrix: const <double>[
        1.1,
        -0.1,
        0.02,
        -0.05,
        1.08,
        -0.03,
        0.01,
        -0.2,
        1.19,
      ],
    );
    final Float32List reference = transform.apply(rgb);
    final RecordingRgbTileStoreFactory factory = RecordingRgbTileStoreFactory();
    final LinearRgbTileStore result = await applyLinearRgbColorTransformTiled(
      inputStore: InMemoryRgbTileStore(
        width: width,
        height: height,
        interleavedRgb: rgb,
      ),
      outputStoreFactory: factory.call,
      transform: transform,
      tileSize: 4,
    );
    final LinearRgbTile actual = await result.readRegion(
      x: 0,
      y: 0,
      width: width,
      height: height,
    );
    expect(actual.interleavedRgb, orderedEquals(reference));
  });

  test('cancellation aborts the partial output store', () async {
    final RecordingRgbTileStoreFactory factory = RecordingRgbTileStoreFactory();
    int checks = 0;
    await expectLater(
      applyLinearRgbColorTransformTiled(
        inputStore: InMemoryRgbTileStore(
          width: 8,
          height: 8,
          interleavedRgb: Float32List(8 * 8 * 3),
        ),
        outputStoreFactory: factory.call,
        transform: LinearRgbColorTransform.identity(),
        tileSize: 4,
        isCancelled: () => ++checks >= 3,
      ),
      throwsA(isA<LinearColorTransformCancelled>()),
    );
    expect(factory.latest?.aborted, isTrue);
  });
}
