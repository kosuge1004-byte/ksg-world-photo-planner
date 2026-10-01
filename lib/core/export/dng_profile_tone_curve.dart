import 'dart:math' as math;

/// Immutable Adobe DNG-compatible natural cubic spline for ProfileToneCurve.
///
/// The input is an interleaved `[x0, y0, x1, y1, ...]` list. Evaluation
/// follows the slope solver and cubic segment formula used by the Adobe DNG
/// SDK. Values above the final knot use the final-knot tangent (slope
/// extension), as required by DNG 1.7.1 for overrange values. Values below
/// the first knot use the first endpoint.
final class DngProfileToneCurve {
  factory DngProfileToneCurve.fromInterleaved(
    List<double> xy, {
    bool isHighDynamicRange = false,
  }) {
    if (xy.length < 4 || xy.length > 16384 || xy.length.isOdd) {
      throw ArgumentError('ProfileToneCurve must contain complete x/y pairs.');
    }
    return DngProfileToneCurve._(
      List<double>.generate(xy.length ~/ 2, (int i) => xy[i * 2]),
      List<double>.generate(xy.length ~/ 2, (int i) => xy[i * 2 + 1]),
      isHighDynamicRange,
    );
  }

  DngProfileToneCurve._(this._x, this._y, this.isHighDynamicRange) {
    _validate();
    _slopes = _solveSlopes();
  }

  final List<double> _x;
  final List<double> _y;
  final bool isHighDynamicRange;
  late final List<double> _slopes;

  int get pointCount => _x.length;

  bool get isIdentity =>
      pointCount == 2 && _x[0] == 0 && _y[0] == 0 && _x[1] == 1 && _y[1] == 1;

  void _validate() {
    if (_x.length < 2 || _x.length > 8192) {
      throw ArgumentError('ProfileToneCurve must contain 2 to 8192 points.');
    }
    // DNG 1.7.1 requires (0,0) as the first knot for both SDR and HDR
    // profiles. SDR additionally requires the final knot to be (1,1). HDR
    // profiles are allowed to end before (1,1), with values beyond the final
    // knot handled by the specified final-slope extension in encoded space.
    if (_x.first != 0 || _y.first != 0) {
      throw ArgumentError('ProfileToneCurve must start at (0, 0).');
    }
    if (!isHighDynamicRange && (_x.last != 1 || _y.last != 1)) {
      throw ArgumentError('SDR ProfileToneCurve must end at (1, 1).');
    }
    for (int index = 0; index < _x.length; index++) {
      final double x = _x[index];
      final double y = _y[index];
      if (!x.isFinite ||
          !y.isFinite ||
          x < 0 ||
          x > 1 ||
          y < 0 ||
          y > 1 ||
          (index != 0 && x <= _x[index - 1])) {
        throw ArgumentError('ProfileToneCurve contains an invalid knot.');
      }
    }
  }

  List<double> _solveSlopes() {
    final int count = _x.length;
    final List<double> slopes = List<double>.filled(count, 0);
    double segmentWidth = _x[1] - _x[0];
    double segmentSlope = (_y[1] - _y[0]) / segmentWidth;
    slopes[0] = segmentSlope;

    for (int index = 2; index < count; index++) {
      final double nextWidth = _x[index] - _x[index - 1];
      final double nextSlope = (_y[index] - _y[index - 1]) / nextWidth;
      slopes[index - 1] =
          (segmentSlope * nextWidth + nextSlope * segmentWidth) /
              (segmentWidth + nextWidth);
      segmentWidth = nextWidth;
      segmentSlope = nextSlope;
    }
    slopes[count - 1] = 2 * segmentSlope - slopes[count - 2];
    slopes[0] = 2 * slopes[0] - slopes[1];

    if (count > 2) {
      final List<double> lower = List<double>.filled(count, 0);
      final List<double> upper = List<double>.filled(count, 0);
      final List<double> rhs = List<double>.filled(count, 0);
      upper[0] = 0.5;
      lower[count - 1] = 0.5;
      rhs[0] = 0.75 * (slopes[0] + slopes[1]);
      rhs[count - 1] = 0.75 * (slopes[count - 2] + slopes[count - 1]);

      for (int index = 1; index < count - 1; index++) {
        final double span = (_x[index + 1] - _x[index - 1]) * 2;
        lower[index] = (_x[index + 1] - _x[index]) / span;
        upper[index] = (_x[index] - _x[index - 1]) / span;
        rhs[index] = 1.5 * slopes[index];
      }
      for (int index = 1; index < count; index++) {
        final double pivot = 1 - upper[index - 1] * lower[index];
        if (index != count - 1) {
          upper[index] /= pivot;
        }
        rhs[index] = (rhs[index] - rhs[index - 1] * lower[index]) / pivot;
      }
      for (int index = count - 2; index >= 0; index--) {
        rhs[index] -= upper[index] * rhs[index + 1];
      }
      return rhs;
    }
    return slopes;
  }

  double evaluate(double value) {
    if (!value.isFinite) return 0;
    final double nonnegative = math.max(0, value);
    if (!isHighDynamicRange) {
      return _evaluateCurveDomain(nonnegative);
    }
    // DNG 1.7 ProfileDynamicRange: HDR ProfileToneCurve is evaluated in
    // the standard overrange-encoded domain, then decoded back to linear
    // gamma. This preserves values above UI white instead of forcing an SDR
    // curve to operate directly on unbounded linear values.
    final double encoded = _encodeOverrange(nonnegative);
    final double curved = _evaluateCurveDomain(encoded);
    return _decodeOverrange(curved);
  }

  double _evaluateCurveDomain(double value) {
    if (!value.isFinite) {
      return 0;
    }
    if (value <= _x.first) {
      return _y.first;
    }
    if (value >= _x.last) {
      final double extended = _y.last + (value - _x.last) * _slopes.last;
      return extended.isFinite ? math.max(0, extended) : 0;
    }
    int lower = 1;
    int upper = _x.length - 1;
    while (upper > lower) {
      final int middle = (lower + upper) >> 1;
      if (value == _x[middle]) {
        return _y[middle];
      }
      if (value > _x[middle]) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    final int right = lower;
    final int left = right - 1;
    final double width = _x[right] - _x[left];
    final double b = (value - _x[left]) / width;
    final double c = (_x[right] - value) / width;
    final double result =
        ((_y[left] * (2 - c + b) + _slopes[left] * width * b) * c * c) +
            ((_y[right] * (2 - b + c) - _slopes[right] * width * c) * b * b);
    if (!result.isFinite) return 0;
    return isHighDynamicRange ? result : math.max(0, math.min(1, result));
  }

  double _encodeOverrange(double value) =>
      value * (256 + value) / (256 * (1 + value));

  double _decodeOverrange(double value) {
    final double x = math.max(0, value);
    return 16 * (8 * x - 8 + math.sqrt(64 * x * x - 127 * x + 64));
  }
}
