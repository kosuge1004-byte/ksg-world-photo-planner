import 'dart:typed_data';

class InvalidLinearColorTransformInput extends ArgumentError {
  InvalidLinearColorTransformInput(String super.message);
}

/// Row-major 3x3 transform from one linear RGB space to another.
///
/// The transform deliberately does not clamp negative or HDR output. Camera
/// color transforms can legitimately produce negative, out-of-gamut values,
/// and highlight headroom must remain linear until the final tone-map stage.
final class LinearRgbColorTransform {
  LinearRgbColorTransform({
    required List<double> matrix,
    this.sourceDescription = 'camera RGB',
    this.destinationDescription = 'linear sRGB',
  }) : _matrix = Float64List.fromList(matrix) {
    if (matrix.length != 9) {
      throw InvalidLinearColorTransformInput(
        'A row-major 3x3 matrix must contain exactly 9 values.',
      );
    }
    if (matrix.any((double value) => !value.isFinite)) {
      throw InvalidLinearColorTransformInput(
        'Color matrix values must all be finite.',
      );
    }
  }

  factory LinearRgbColorTransform.identity() => LinearRgbColorTransform(
        matrix: const <double>[
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
        sourceDescription: 'linear RGB',
        destinationDescription: 'linear RGB',
      );

  final Float64List _matrix;

  /// Defensive read-only copy so callers cannot mutate the transform.
  List<double> get matrix => List<double>.unmodifiable(_matrix);
  final String sourceDescription;
  final String destinationDescription;

  void transformPixel(
    double red,
    double green,
    double blue,
    Float64List output,
  ) {
    if (output.length < 3) {
      throw InvalidLinearColorTransformInput(
        'Pixel output must contain at least 3 values.',
      );
    }
    if (!red.isFinite || !green.isFinite || !blue.isFinite) {
      throw InvalidLinearColorTransformInput(
        'Linear RGB input samples must all be finite.',
      );
    }
    final double r = red;
    final double g = green;
    final double b = blue;
    final double transformedRed =
        _matrix[0] * r + _matrix[1] * g + _matrix[2] * b;
    final double transformedGreen =
        _matrix[3] * r + _matrix[4] * g + _matrix[5] * b;
    final double transformedBlue =
        _matrix[6] * r + _matrix[7] * g + _matrix[8] * b;
    for (final double value in <double>[
      transformedRed,
      transformedGreen,
      transformedBlue,
    ]) {
      if (!value.isFinite || value.abs() > _maximumFloat32) {
        throw InvalidLinearColorTransformInput(
          'Color transform produced a value outside the finite FP32 range.',
        );
      }
    }
    output[0] = transformedRed;
    output[1] = transformedGreen;
    output[2] = transformedBlue;
  }

  Float32List apply(Float32List interleavedRgb) {
    if (interleavedRgb.length % 3 != 0) {
      throw InvalidLinearColorTransformInput(
        'RGB input length must be a multiple of 3.',
      );
    }
    final Float32List output = Float32List(interleavedRgb.length);
    final Float64List transformed = Float64List(3);
    for (int index = 0; index < interleavedRgb.length; index += 3) {
      transformPixel(
        interleavedRgb[index],
        interleavedRgb[index + 1],
        interleavedRgb[index + 2],
        transformed,
      );
      _storeFiniteFloat32(output, index, transformed[0]);
      _storeFiniteFloat32(output, index + 1, transformed[1]);
      _storeFiniteFloat32(output, index + 2, transformed[2]);
    }
    return output;
  }
}

const double _maximumFloat32 = 3.4028234663852886e38;

void _storeFiniteFloat32(Float32List output, int index, double value) {
  if (!value.isFinite || value.abs() > _maximumFloat32) {
    throw InvalidLinearColorTransformInput(
      'Color transform produced a value outside the finite FP32 range.',
    );
  }
  output[index] = value;
}
