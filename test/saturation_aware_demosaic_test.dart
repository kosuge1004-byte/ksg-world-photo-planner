import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/demosaic/demosaic_request.dart';
import 'package:mobile_stack/core/demosaic/mobile_stack_adaptive_demosaic_engine.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

void main() {
  test(
      'excludes a clipped same-color neighbor from color-difference interpolation',
      () async {
    const int width = 12;
    const int height = 12;
    const int clippedX = 4;
    const int clippedY = 4;
    final Float32List samples = Float32List(width * height);
    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) {
        samples[y * width + x] = switch (CfaPattern.rggb.colorAt(x, y)) {
          CfaColor.red => 0.8,
          CfaColor.green => 0.5,
          CfaColor.blue => 0.2,
        };
      }
    }
    samples[clippedY * width + clippedX] = 1;
    final LinearRawMosaic unmasked = LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(samples),
    );
    final LinearRawMosaic masked = LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(samples),
      saturationMask: RawSaturationMask.fromPredicate(
        width * height,
        (int index) => index == clippedY * width + clippedX,
      ),
    );
    final OverlappedTile tile = OverlappedTilePlan.create(
      imageWidth: width,
      imageHeight: height,
      tileSize: width,
      overlap: MobileStackAdaptiveDemosaicEngine.referenceRequiredInputRadius,
    ).tiles.single;
    const MobileStackAdaptiveDemosaicEngine engine =
        MobileStackAdaptiveDemosaicEngine();

    await engine.processTile(DemosaicRequest(mosaic: unmasked, tile: tile));
    final maskedRgb = await engine.processTile(
      DemosaicRequest(mosaic: masked, tile: tile),
    );

    const int targetX = 5;
    const int targetY = 4;
    expect(maskedRgb.channelAt(targetX, targetY, 0), closeTo(0.8, 2e-6));
    expect(maskedRgb.channelAt(clippedX, clippedY, 0), 1);
  });
}
