import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/color/linear_rgb_color_transform.dart';

void main() {
  test('row-major 3x3 matrix transforms each linear RGB triple', () {
    final LinearRgbColorTransform transform = LinearRgbColorTransform(
      matrix: const <double>[
        1,
        2,
        3,
        0,
        1,
        0,
        0.5,
        0,
        0.5,
      ],
    );
    expect(
      transform.apply(Float32List.fromList(<double>[1, 2, 3])),
      orderedEquals(<double>[14, 2, 2]),
    );
  });

  test('identity preserves finite HDR and negative out-of-gamut values', () {
    final Float32List input = Float32List.fromList(<double>[-0.2, 4, 0.5]);
    expect(
      LinearRgbColorTransform.identity().apply(input),
      orderedEquals(input),
    );
  });

  test('non-finite source samples are rejected instead of fabricated as black',
      () {
    expect(
      () => LinearRgbColorTransform.identity().apply(
        Float32List.fromList(
          <double>[double.nan, double.infinity, double.negativeInfinity],
        ),
      ),
      throwsA(isA<InvalidLinearColorTransformInput>()),
    );
  });

  test('invalid matrix and malformed input are rejected', () {
    expect(
      () => LinearRgbColorTransform(matrix: const <double>[1]),
      throwsA(isA<InvalidLinearColorTransformInput>()),
    );
    expect(
      () => LinearRgbColorTransform(
        matrix: const <double>[
          double.nan,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          1,
        ],
      ),
      throwsA(isA<InvalidLinearColorTransformInput>()),
    );
    expect(
      () => LinearRgbColorTransform.identity().apply(Float32List(2)),
      throwsA(isA<InvalidLinearColorTransformInput>()),
    );
  });
}
