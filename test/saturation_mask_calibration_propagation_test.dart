import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';
import 'package:mobile_stack/core/pipeline/dark_frame_subtraction.dart';
import 'package:mobile_stack/core/pipeline/flat_field_calibration.dart';
import 'package:mobile_stack/core/pipeline/raw_mosaic_calibrator.dart';

LinearRawMosaic _plain(List<double> values) => LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(values),
    );

void main() {
  test('in-place RAW calibration retains the original sensor mask', () async {
    final RawSaturationMask mask = RawSaturationMask.fromPredicate(
      4,
      (int index) => index == 3,
    );
    final LinearRawMosaic light = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[10, 20, 30, 100]),
      saturationMask: mask,
    );
    const RawMosaicCalibrator calibrator = RawMosaicCalibrator();

    await calibrator.subtractBlackLevels(
      light,
      blackLevels: const <double>[1, 2, 3, 4],
    );
    await calibrator.normalizeWhiteLevel(
      light,
      blackLevels: const <double>[1, 2, 3, 4],
      whiteLevel: 100,
    );
    await calibrator.applyCameraWhiteBalance(
      light,
      gains: const <double>[2, 1, 1, 1.5],
    );

    expect(light.saturationMask, same(mask));
    expect(light.isSaturatedAt(1, 1), isTrue);
  });

  test('dark and flat corrections propagate the light mask unchanged', () {
    final RawSaturationMask mask = RawSaturationMask.fromPredicate(
      4,
      (int index) => index == 1,
    );
    final LinearRawMosaic light = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[10, 20, 30, 40]),
      saturationMask: mask,
    );

    final LinearRawMosaic darkCorrected = subtractDarkFrame(
      light,
      _plain(<double>[1, 1, 1, 1]),
    );
    final LinearRawMosaic flatCorrected = applyFlatFieldCorrection(
      darkCorrected,
      _plain(<double>[1, 2, 1, 2]),
    );

    expect(
      darkCorrected.saturationMask!.toPackedBytes(),
      orderedEquals(mask.toPackedBytes()),
    );
    expect(
      flatCorrected.saturationMask!.toPackedBytes(),
      orderedEquals(mask.toPackedBytes()),
    );
    expect(flatCorrected.isSaturatedAt(1, 0), isTrue);
  });
}
