import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/cfa_drizzle_dng_validity.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

void main() {
  test('streaming CFA demosaic mask matches legacy full builder', () async {
    const int width = 9;
    const int height = 7;
    final OverlappedTilePlan plan = OverlappedTilePlan.create(
      imageWidth: width,
      imageHeight: height,
      tileSize: width,
      overlap: 0,
    );
    final store = await FileBackedLinearRgbTileStore.createTemporary(
      width: width,
      height: height,
      plan: plan,
    );

    final Float32List coverage = Float32List(width * height * 3);
    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) {
        final int base = (y * width + x) * 3;
        coverage[base] = 1.0;
        coverage[base + 1] = 1.0;
        coverage[base + 2] = 1.0;
      }
    }
    // Make several native-CFA sites source-invalid.
    for (final ({int x, int y}) p in <({int x, int y})>[
      (x: 0, y: 0),
      (x: 4, y: 3),
      (x: 8, y: 6),
    ]) {
      final int c = CfaPattern.rggb.colorAt(p.x, p.y).index;
      coverage[(p.y * width + p.x) * 3 + c] = 0.1;
    }

    await store.writeTile(
      LinearRgbTile(
        x: 0,
        y: 0,
        width: width,
        height: height,
        interleavedRgb: coverage,
      ),
    );
    await store.commit();

    final RawSaturationMask extraInvalid = RawSaturationMask.fromPredicate(
      width * height,
      (int i) => i == 20 || i == 43,
    );

    try {
      final Uint8List expected = await buildCfaDrizzleDemosaicTransparencyMask(
        coverageStore: store,
        referenceCfaPattern: CfaPattern.rggb,
        minimumCoverage: 0.5,
        reconstructedInvalidMask: extraInvalid,
        requiredInputRadius: 2,
        rowsPerRead: 2,
      );

      final CfaDrizzleDemosaicTransparencyMaskSource source =
          CfaDrizzleDemosaicTransparencyMaskSource(
        coverageStore: store,
        referenceCfaPattern: CfaPattern.rggb,
        minimumCoverage: 0.5,
        reconstructedInvalidMask: extraInvalid,
        requiredInputRadius: 2,
      );

      final Uint8List actual = Uint8List(width * height);
      int outY = 0;
      for (final int rows in <int>[1, 3, 2, 1]) {
        final Uint8List part =
            await source.readRows(startY: outY, rowCount: rows);
        actual.setRange(outY * width, (outY + rows) * width, part);
        outY += rows;
      }
      expect(outY, height);
      expect(actual, orderedEquals(expected));
    } finally {
      await store.dispose();
    }
  });
}
