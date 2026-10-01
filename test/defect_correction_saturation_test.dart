import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';
import 'package:mobile_stack/core/pipeline/raw_defect_map.dart';
import 'package:mobile_stack/core/pipeline/raw_defect_pixel_corrector.dart';

void main() {
  test('does not use a saturated same-phase neighbor as defect replacement',
      () async {
    const int width = 9;
    const int height = 9;
    final Float32List samples = Float32List.fromList(
      <double>[for (int i = 0; i < width * height; i++) 1],
    );
    samples[4 * width + 4] = 99;
    samples[4 * width + 2] = 50;
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
      samples: samples,
      saturationMask: RawSaturationMask.fromPredicate(
        width * height,
        (int index) => index == 4 * width + 2,
      ),
    );

    await const RawDefectPixelCorrector().correct(
      mosaic,
      RawDefectMap(
        const <RawDefectPoint>[RawDefectPoint(x: 4, y: 4)],
      ),
    );

    expect(mosaic.sampleAt(4, 4), closeTo(1, 1e-6));
  });
}
