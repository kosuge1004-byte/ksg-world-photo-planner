import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/tiled_reconstruct_native_cfa_from_drizzle.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

import 'support/recording_rgb_tile_store.dart';

Future<LinearRgbTileStore> _store(
  int width,
  int height,
  Float32List samples,
) async {
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width,
    imageHeight: height,
    tileSize: width,
    overlap: 0,
  );
  final LinearRgbTileStore store = await RecordingRgbTileStoreFactory().call(
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
  test('reconstructs a native-CFA mask from weighted saturation coverage',
      () async {
    const int width = 4;
    const int height = 4;
    final Float32List values = Float32List(width * height * 3);
    final Float32List coverage = Float32List(width * height * 3);
    final Float32List saturation = Float32List(width * height * 3);
    for (int pixel = 0; pixel < width * height; pixel++) {
      for (int channel = 0; channel < 3; channel++) {
        values[pixel * 3 + channel] = pixel + channel / 10;
        coverage[pixel * 3 + channel] = 1;
      }
    }
    saturation[0 * 3 + 0] = 1; // (0,0) native red: 1/(1+1) saturated.
    saturation[1 * 3 + 1] = 0.4; // (1,0) native green: recoverable.
    saturation[2 * 3 + 1] = 1; // Non-native at (2,0), must be ignored.

    final LinearRawMosaic reconstructed =
        await reconstructNativeCfaMosaicFromDrizzleTiled(
      valueStore: await _store(width, height, values),
      coverageStore: await _store(width, height, coverage),
      saturationCoverageStore: await _store(width, height, saturation),
      referenceCfaPattern: CfaPattern.rggb,
      stripHeight: 2,
      minimumSaturationFraction: 0.5,
    );

    expect(reconstructed.saturationMask, isNotNull);
    expect(reconstructed.saturationMask!.saturatedCount, 1);
    expect(reconstructed.isSaturatedAt(0, 0), isTrue);
    expect(reconstructed.isSaturatedAt(1, 0), isFalse);
    expect(reconstructed.isSaturatedAt(2, 0), isFalse);
  });

  test('uses pre-rejection coverage for saturation decisions when provided',
      () async {
    const int width = 2;
    const int height = 2;
    final Float32List values = Float32List(width * height * 3);
    final Float32List survivorCoverage = Float32List.fromList(
      <double>[for (int i = 0; i < width * height * 3; i++) 1],
    );
    final Float32List preRejectionCoverage = Float32List.fromList(
      <double>[for (int i = 0; i < width * height * 3; i++) 3],
    );
    final Float32List saturation = Float32List(width * height * 3);
    saturation[0] = 1;

    final LinearRawMosaic reconstructed =
        await reconstructNativeCfaMosaicFromDrizzleTiled(
      valueStore: await _store(width, height, values),
      coverageStore: await _store(width, height, survivorCoverage),
      saturationCoverageStore: await _store(width, height, saturation),
      saturationDecisionCoverageStore:
          await _store(width, height, preRejectionCoverage),
      referenceCfaPattern: CfaPattern.rggb,
      minimumSaturationFraction: 0.5,
    );

    // Survivor-only coverage would produce 1 / (1 + 1) == 0.5 and
    // incorrectly mark this pixel saturated. The original observation set
    // is 1 saturated out of 4 weighted observations, so it must remain
    // recoverable after robust rejection.
    expect(reconstructed.isSaturatedAt(0, 0), isFalse);
  });

  test('omitted saturation plane preserves legacy null-mask behavior',
      () async {
    const int width = 2;
    const int height = 2;
    final Float32List values = Float32List(width * height * 3);
    final Float32List coverage = Float32List.fromList(
      <double>[for (int i = 0; i < width * height * 3; i++) 1],
    );
    final LinearRawMosaic reconstructed =
        await reconstructNativeCfaMosaicFromDrizzleTiled(
      valueStore: await _store(width, height, values),
      coverageStore: await _store(width, height, coverage),
      referenceCfaPattern: CfaPattern.rggb,
    );
    expect(reconstructed.saturationMask, isNull);
  });
}
