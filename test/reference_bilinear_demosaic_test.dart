import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/demosaic/demosaic_request.dart';
import 'package:mobile_stack/core/demosaic/reference_bilinear_demosaic.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

void main() {
  test('preserves native CFA samples in their own channels', () async {
    final mosaic = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[1, 2, 3, 4]),
    );

    final image = await const ReferenceBilinearDemosaic().processTile(
      DemosaicRequest(
        mosaic: mosaic,
        tile: const OverlappedTile(
          outputX: 0,
          outputY: 0,
          outputWidth: 2,
          outputHeight: 2,
          inputX: 0,
          inputY: 0,
          inputWidth: 2,
          inputHeight: 2,
        ),
      ),
    );

    expect(image.channelAt(0, 0, 0), 1);
    expect(image.channelAt(1, 0, 1), 2);
    expect(image.channelAt(0, 1, 1), 3);
    expect(image.channelAt(1, 1, 2), 4);
  });

  test('部分タイルでも画像全体のCFA位相を維持する', () async {
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: 4,
      height: 4,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(
        List<double>.generate(16, (int index) => index.toDouble()),
      ),
    );

    final image = await const ReferenceBilinearDemosaic().processTile(
      DemosaicRequest(
        mosaic: mosaic,
        tile: const OverlappedTile(
          outputX: 1,
          outputY: 1,
          outputWidth: 2,
          outputHeight: 2,
          inputX: 0,
          inputY: 0,
          inputWidth: 4,
          inputHeight: 4,
        ),
      ),
    );

    expect(image.x, 1);
    expect(image.y, 1);
    expect(image.channelAt(0, 0, 2), 5);
    expect(image.channelAt(1, 0, 1), 6);
    expect(image.channelAt(0, 1, 1), 9);
    expect(image.channelAt(1, 1, 0), 10);
  });
}
