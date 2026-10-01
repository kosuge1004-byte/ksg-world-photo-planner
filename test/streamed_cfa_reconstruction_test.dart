import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/tiled_reconstruct_native_cfa_from_drizzle.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

Future<FileBackedLinearRgbTileStore> _store({
  required int width,
  required int height,
  required Float32List samples,
}) async {
  final plan = OverlappedTilePlan.create(
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
  await store.writeTile(
    LinearRgbTile(
      x: 0,
      y: 0,
      width: width,
      height: height,
      interleavedRgb: samples,
    ),
  );
  await store.commit();
  return store;
}

void main() {
  test('streamed CFA reconstruction matches legacy tiled reconstruction',
      () async {
    const width = 7;
    const height = 5;
    final value = Float32List(width * height * 3);
    final coverage = Float32List(width * height * 3);
    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) {
        for (int c = 0; c < 3; c++) {
          final i = (y * width + x) * 3 + c;
          value[i] = (i + 1) / 17.0;
          coverage[i] = ((x + y + c) % 4 == 0) ? 0.0 : 1.0 + c * 0.25;
        }
      }
    }
    final values = await _store(width: width, height: height, samples: value);
    final coverages =
        await _store(width: width, height: height, samples: coverage);
    try {
      final legacy = await reconstructNativeCfaMosaicFromDrizzleTiled(
        valueStore: values,
        coverageStore: coverages,
        referenceCfaPattern: CfaPattern.rggb,
        stripHeight: 2,
        gapFillKernelRadius: 2,
      );
      final streamed = await reconstructNativeCfaStoreFromDrizzleStreamed(
        valueStore: values,
        coverageStore: coverages,
        referenceCfaPattern: CfaPattern.rggb,
        stripHeight: 2,
        kernelRadius: 2,
      );
      try {
        final actual = await streamed.store.readRegion(
          x: 0,
          y: 0,
          width: width,
          height: height,
        );
        expect(actual, orderedEquals(legacy.samples));
      } finally {
        await streamed.store.dispose();
      }
    } finally {
      await values.dispose();
      await coverages.dispose();
    }
  });
}
