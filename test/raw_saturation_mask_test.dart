import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';

void main() {
  test('stores exact flags in one bit per pixel across byte boundaries', () {
    final Set<int> saturated = <int>{0, 7, 8, 18};
    final RawSaturationMask mask = RawSaturationMask.fromPredicate(
      19,
      saturated.contains,
    );

    expect(mask.packedByteLength, 3);
    expect(mask.saturatedCount, 4);
    for (int index = 0; index < 19; index++) {
      expect(mask.isSaturatedIndex(index), saturated.contains(index));
    }
  });

  test('LinearRawMosaic validates and exposes saturation coordinates', () {
    final RawSaturationMask mask = RawSaturationMask.fromPredicate(
      6,
      (int index) => index == 5,
    );
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: 3,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List(6),
      saturationMask: mask,
    );

    expect(mosaic.isSaturatedAt(2, 1), isTrue);
    expect(mosaic.isSaturatedAt(0, 0), isFalse);
    expect(() => mosaic.isSaturatedAt(3, 0), throwsRangeError);
    expect(
      () => LinearRawMosaic(
        width: 3,
        height: 2,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List(6),
        saturationMask: RawSaturationMask.fromPredicate(5, (_) => false),
      ),
      throwsArgumentError,
    );
  });
  test(
      'Chebyshev dilation expands one saturated RAW site by the exact requested radius',
      () {
    final RawSaturationMask mask = RawSaturationMask.fromPredicate(
      7 * 7,
      (int index) => index == 3 * 7 + 3,
    );
    final RawSaturationMask dilated = mask.dilatedChebyshev(
      width: 7,
      height: 7,
      radius: 2,
    );
    expect(dilated.saturatedCount, 25);
    for (int y = 0; y < 7; y++) {
      for (int x = 0; x < 7; x++) {
        final bool expected = (x - 3).abs() <= 2 && (y - 3).abs() <= 2;
        expect(dilated.isSaturatedIndex(y * 7 + x), expected);
      }
    }
  });

  test('Chebyshev dilation clips safely at image edges', () {
    final RawSaturationMask mask = RawSaturationMask.fromPredicate(
      5 * 5,
      (int index) => index == 0,
    );
    final RawSaturationMask dilated = mask.dilatedChebyshev(
      width: 5,
      height: 5,
      radius: 2,
    );
    expect(dilated.saturatedCount, 9);
    for (int y = 0; y < 5; y++) {
      for (int x = 0; x < 5; x++) {
        expect(
          dilated.isSaturatedIndex(y * 5 + x),
          x <= 2 && y <= 2,
        );
      }
    }
  });

  test('sparse full-sensor dilation preserves random access and packed export',
      () {
    const int width = 1000;
    const int height = 1000;
    final RawSaturationMask mask = RawSaturationMask.fromPredicate(
      width * height,
      (int index) => index == 500 * width + 500,
    );
    final RawSaturationMask dilated = mask.dilatedChebyshev(
      width: width,
      height: height,
      radius: 5,
    );
    expect(dilated.saturatedCount, 121);
    expect(dilated.isSaturatedIndex(495 * width + 495), isTrue);
    expect(dilated.isSaturatedIndex(505 * width + 505), isTrue);
    expect(dilated.isSaturatedIndex(494 * width + 500), isFalse);
    final Uint8List packed = dilated.toPackedBytes();
    expect(packed.length, (width * height + 7) >> 3);
    expect(
        (packed[(500 * width + 500) >> 3] & (1 << ((500 * width + 500) & 7))) !=
            0,
        isTrue);
  });
}

void mainWork292RawSaturationMaskTests() {
  test('fromFiniteFloat32Threshold preserves >= white-level semantics', () {
    final RawSaturationMask mask = RawSaturationMask.fromFiniteFloat32Threshold(
      Float32List.fromList(<double>[0, 9, 10, 11, 5]),
      10,
    );
    expect(mask.saturatedCount, 2);
    expect(mask.isSaturatedIndex(2), isTrue);
    expect(mask.isSaturatedIndex(3), isTrue);
    expect(mask.isSaturatedIndex(1), isFalse);
  });

  test('fromFiniteFloat32Threshold rejects non-finite RAW samples', () {
    expect(
      () => RawSaturationMask.fromFiniteFloat32Threshold(
        Float32List.fromList(<double>[1, double.nan, 3]),
        10,
      ),
      throwsStateError,
    );
  });
}
