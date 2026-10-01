import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';
import 'package:mobile_stack/core/pipeline/dark_frame_subtraction.dart';
import 'package:mobile_stack/core/pipeline/flat_field_calibration.dart';

LinearRawMosaic _mosaic(List<double> values, {RawSaturationMask? mask}) {
  return LinearRawMosaic(
    width: 4,
    height: 2,
    cfaPattern: CfaPattern.rggb,
    samples: Float32List.fromList(values),
    saturationMask: mask,
  );
}

void main() {
  test('dark in-place path is numerically/mask equivalent and reuses samples',
      () {
    final mask = RawSaturationMask.fromPredicate(8, (i) => i == 1);
    final darkMask = RawSaturationMask.fromPredicate(8, (i) => i == 6);
    final a = _mosaic([10, 20, 30, 40, 50, 60, 70, 80], mask: mask);
    final b = _mosaic([10, 20, 30, 40, 50, 60, 70, 80], mask: mask);
    final dark = _mosaic([1, 2, 3, 4, 5, 6, 7, 8], mask: darkMask);
    final expected = subtractDarkFrame(a, dark);
    final originalSamples = b.samples;
    final actual = subtractDarkFrameInPlace(b, dark);
    expect(identical(actual.samples, originalSamples), isTrue);
    expect(actual.samples, orderedEquals(expected.samples));
    for (var i = 0; i < 8; i++) {
      expect(actual.saturationMask?.isSaturatedIndex(i) ?? false,
          expected.saturationMask?.isSaturatedIndex(i) ?? false);
    }
  });

  test('flat in-place path is numerically/mask equivalent and reuses samples',
      () {
    final mask = RawSaturationMask.fromPredicate(8, (i) => i == 2);
    final flatMask = RawSaturationMask.fromPredicate(8, (i) => i == 5);
    final a = _mosaic([10, 20, 30, 40, 50, 60, 70, 80], mask: mask);
    final b = _mosaic([10, 20, 30, 40, 50, 60, 70, 80], mask: mask);
    final flat = _mosaic([1, 2, 0.01, 4, 5, 6, 7, 8], mask: flatMask);
    final expected = applyFlatFieldCorrection(a, flat);
    final originalSamples = b.samples;
    final actual = applyFlatFieldCorrectionInPlace(b, flat);
    expect(identical(actual.samples, originalSamples), isTrue);
    expect(actual.samples, orderedEquals(expected.samples));
    for (var i = 0; i < 8; i++) {
      expect(actual.saturationMask?.isSaturatedIndex(i) ?? false,
          expected.saturationMask?.isSaturatedIndex(i) ?? false);
    }
  });
}
