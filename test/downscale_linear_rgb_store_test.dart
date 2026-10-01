import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/downscale_linear_rgb_store.dart';

import 'support/in_memory_rgb_tile_store.dart';
import 'support/recording_rgb_tile_store.dart';

void main() {
  test('50%設定は縦横を半分にして線形値を補間する', () async {
    final Float32List pixels = Float32List(4 * 4 * 3);
    for (int y = 0; y < 4; y++) {
      for (int x = 0; x < 4; x++) {
        final int base = (y * 4 + x) * 3;
        pixels[base] = x.toDouble();
        pixels[base + 1] = y.toDouble();
        pixels[base + 2] = (x + y).toDouble();
      }
    }
    final source = InMemoryRgbTileStore(
      width: 4,
      height: 4,
      interleavedRgb: pixels,
    );
    final factory = RecordingRgbTileStoreFactory();
    final output = await downscaleLinearRgbStore(
      source: source,
      linearScale: 0.5,
      outputStoreFactory: factory.call,
      tileSize: 2,
    );
    final tile = await output.readRegion(x: 0, y: 0, width: 2, height: 2);
    expect(output.width, 2);
    expect(output.height, 2);
    expect(tile.interleavedRgb[0], closeTo(0.5, 1e-6));
    expect(tile.interleavedRgb[1], closeTo(0.5, 1e-6));
    expect(tile.interleavedRgb[11], closeTo(5, 1e-6));
  });
}
