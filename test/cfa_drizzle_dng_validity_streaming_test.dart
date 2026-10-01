import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/cfa_drizzle_dng_validity.dart';

import 'support/in_memory_rgb_tile_store.dart';

void main() {
  test('streaming CFA drizzle RGB mask preserves direct-support validity',
      () async {
    final InMemoryRgbTileStore coverage = InMemoryRgbTileStore(
      width: 2,
      height: 2,
      interleavedRgb: Float32List.fromList(<double>[
        1,
        1,
        1,
        1,
        0,
        1,
        2,
        2,
        2,
        0.5,
        0.5,
        0.5,
      ]),
    );
    final CfaDrizzleRgbTransparencyMaskSource source =
        CfaDrizzleRgbTransparencyMaskSource(
      coverageStore: coverage,
      minimumCoverage: 0.5,
    );

    final Uint8List mask = await source.readRows(startY: 0, rowCount: 2);
    expect(mask, orderedEquals(<int>[255, 0, 255, 255]));
    expect(coverage.readRequests.length, 1);
    expect(coverage.readRequests.single.height, 2);
  });

  test('streaming CFA drizzle RGB mask keeps saturation rejection semantics',
      () async {
    final InMemoryRgbTileStore coverage = InMemoryRgbTileStore(
      width: 1,
      height: 2,
      interleavedRgb: Float32List.fromList(<double>[
        1,
        1,
        1,
        1,
        1,
        1,
      ]),
    );
    final InMemoryRgbTileStore saturation = InMemoryRgbTileStore(
      width: 1,
      height: 2,
      interleavedRgb: Float32List.fromList(<double>[
        1,
        0,
        0,
        0.1,
        0.1,
        0.1,
      ]),
    );
    final InMemoryRgbTileStore decision = InMemoryRgbTileStore(
      width: 1,
      height: 2,
      interleavedRgb: Float32List.fromList(<double>[
        1,
        1,
        1,
        1,
        1,
        1,
      ]),
    );
    final CfaDrizzleRgbTransparencyMaskSource source =
        CfaDrizzleRgbTransparencyMaskSource(
      coverageStore: coverage,
      saturationCoverageStore: saturation,
      saturationDecisionCoverageStore: decision,
      minimumCoverage: 0.5,
      minimumSaturationFraction: 0.5,
    );

    final Uint8List mask = await source.readRows(startY: 0, rowCount: 2);
    expect(mask, orderedEquals(<int>[0, 255]));
  });
}
