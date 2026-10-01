import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/color/dng_d65_color_transform.dart';
import 'package:mobile_stack/core/color/linear_rgb_color_transform.dart';

void main() {
  test('camera space equal to linear sRGB produces an identity transform', () {
    final LinearRgbColorTransform transform = linearSrgbTransformFromDngD65(
      xyzToCameraD65: d65XyzToLinearSrgb,
      cameraWhiteBalanceRgb: const <double>[1, 1, 1],
    );
    final Float32List input = Float32List.fromList(<double>[
      0.1,
      0.2,
      0.3,
      4,
      -0.2,
      1,
    ]);
    final Float32List output = transform.apply(input);
    for (int index = 0; index < input.length; index++) {
      expect((output[index] - input[index]).abs(), lessThan(2e-6));
    }
  });

  test('pre-applied camera white balance maps camera neutral to D65 gray', () {
    final LinearRgbColorTransform transform = linearSrgbTransformFromDngD65(
      xyzToCameraD65: const <double>[
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
      ],
      cameraWhiteBalanceRgb: const <double>[2, 1, 0.5],
    );
    final Float32List cameraAfterWhiteBalance =
        Float32List.fromList(<double>[1, 1, 1]);
    final Float32List output = transform.apply(cameraAfterWhiteBalance);
    expect((output[0] - output[1]).abs(), lessThan(3e-4));
    expect((output[1] - output[2]).abs(), lessThan(3e-4));
    expect(output[1], closeTo(1, 3e-4));
  });

  test('singular, malformed, and unsafe inputs are rejected', () {
    expect(
      () => linearSrgbTransformFromDngD65(
        xyzToCameraD65: List<double>.filled(9, 0),
        cameraWhiteBalanceRgb: const <double>[1, 1, 1],
      ),
      throwsA(isA<InvalidDngColorTransformInput>()),
    );
    expect(
      () => linearSrgbTransformFromDngD65(
        xyzToCameraD65: d65XyzToLinearSrgb,
        cameraWhiteBalanceRgb: const <double>[1, 0, 1],
      ),
      throwsA(isA<InvalidDngColorTransformInput>()),
    );
    expect(
      () => linearSrgbTransformFromDngD65(
        xyzToCameraD65: const <double>[1],
        cameraWhiteBalanceRgb: const <double>[1, 1, 1],
      ),
      throwsA(isA<InvalidDngColorTransformInput>()),
    );
  });

  test('ProPhoto D50 profile working space round-trips to linear sRGB', () {
    final LinearRgbColorTransform toProPhoto =
        linearProPhotoTransformFromDngD65(
      xyzToCameraD65: d65XyzToLinearSrgb,
      cameraWhiteBalanceRgb: const <double>[1, 1, 1],
    );
    final LinearRgbColorTransform toSrgb =
        linearSrgbTransformFromLinearProPhoto();
    final Float32List input = Float32List.fromList(<double>[
      0.05,
      0.25,
      0.8,
      1.2,
      0.4,
      0.1,
    ]);
    final Float32List restored = toSrgb.apply(toProPhoto.apply(input));
    for (int index = 0; index < input.length; index++) {
      expect((restored[index] - input[index]).abs(), lessThan(5e-4));
    }
  });

  test('severely ill-conditioned camera matrices are rejected', () {
    expect(
      () => linearSrgbTransformFromDngD65(
        xyzToCameraD65: const <double>[
          1,
          1,
          1,
          1,
          1.00001,
          1,
          1,
          1,
          1.00001,
        ],
        cameraWhiteBalanceRgb: const <double>[1, 1, 1],
      ),
      throwsA(isA<InvalidDngColorTransformInput>()),
    );
  });
}
