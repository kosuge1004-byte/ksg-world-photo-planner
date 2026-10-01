import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/tiled_cfa_drizzle.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_raw_mosaic_store.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';

import 'support/recording_rgb_tile_store.dart';

void main() {
  test('projects saturated sensor-site footprint into a separate plane',
      () async {
    const int width = 5;
    const int height = 5;
    const int saturatedIndex = 2 * width + 2;
    final FileBackedLinearRawMosaicStore source =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await source.writeFull(
        LinearRawMosaic(
          width: width,
          height: height,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List.fromList(
            <double>[for (int i = 0; i < width * height; i++) i + 1],
          ),
          saturationMask: RawSaturationMask.fromPredicate(
            width * height,
            (int index) => index == saturatedIndex,
          ),
        ),
      );
      final CfaDrizzleTiledResult result = await drizzleCfaTiled(
        frames: <CfaDrizzleTiledFrame>[
          CfaDrizzleTiledFrame(mosaicStore: source),
        ],
        outputWidth: width,
        outputHeight: height,
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        tileSize: 3,
        outputScale: 1,
        pixfrac: 1,
      );

      expect(result.saturationCoverageStore, isNotNull);
      final LinearRgbTile saturation =
          await result.saturationCoverageStore!.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      double total = 0;
      for (final double value in saturation.interleavedRgb) {
        total += value;
      }
      expect(total, closeTo(1, 1e-6));
      expect(saturation.channelAt(2, 2, 0), closeTo(1, 1e-6));
      expect(saturation.channelAt(2, 2, 1), 0);
      expect(saturation.channelAt(2, 2, 2), 0);
    } finally {
      await source.dispose();
    }
  });

  test('does not allocate an output plane when no sensor site saturated',
      () async {
    final FileBackedLinearRawMosaicStore source =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await source.writeFull(
        LinearRawMosaic(
          width: 2,
          height: 2,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List(4),
          saturationMask: RawSaturationMask.fromPredicate(4, (_) => false),
        ),
      );
      final CfaDrizzleTiledResult result = await drizzleCfaTiled(
        frames: <CfaDrizzleTiledFrame>[
          CfaDrizzleTiledFrame(mosaicStore: source),
        ],
        outputWidth: 2,
        outputHeight: 2,
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        tileSize: 2,
        outputScale: 1,
        pixfrac: 1,
      );
      expect(result.saturationCoverageStore, isNull);
    } finally {
      await source.dispose();
    }
  });
}
