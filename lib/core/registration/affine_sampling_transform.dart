import 'dart:math' as math;

/// Maps an output/reference pixel coordinate to the source frame coordinate
/// that must be sampled for alignment.
///
/// Keeping this as an inverse sampling transform avoids holes in the output
/// and lets rotation plus translation be applied in one interpolation pass.
///
/// Work351: optional projective terms [p20]/[p21] turn the map into a plane
/// homography, `source = (m00 x + m01 y + m02, m10 x + m11 y + m12) /
/// (p20 x + p21 y + 1)`. This is the exact image-plane model of a fixed
/// camera watching the rotating sky through a rectilinear lens (K R K^-1).
/// Both terms default to 0, in which case every method evaluates exactly the
/// same floating-point expressions as before Work351 (bit-identical output
/// for every existing caller).
final class AffineSamplingTransform {
  AffineSamplingTransform({
    required this.m00,
    required this.m01,
    required this.m02,
    required this.m10,
    required this.m11,
    required this.m12,
    this.p20 = 0,
    this.p21 = 0,
  }) {
    if (<double>[m00, m01, m02, m10, m11, m12, p20, p21]
        .any((double value) => !value.isFinite)) {
      throw ArgumentError('Affine sampling coefficients must be finite.');
    }
  }

  factory AffineSamplingTransform.identity() => AffineSamplingTransform(
        m00: 1,
        m01: 0,
        m02: 0,
        m10: 0,
        m11: 1,
        m12: 0,
      );

  /// Creates a single inverse sampling map around an explicit image center.
  ///
  /// For each output coordinate, the source coordinate is
  /// `center + R(rotation) * (output - center) + sourceOffset`.
  /// The offset therefore describes where the corresponding reference point
  /// is found in the source frame; it is not an output-space forward shift.
  factory AffineSamplingTransform.similarity({
    required double rotationDegrees,
    required double sourceOffsetX,
    required double sourceOffsetY,
    required double centerX,
    required double centerY,
  }) {
    if (<double>[
      rotationDegrees,
      sourceOffsetX,
      sourceOffsetY,
      centerX,
      centerY,
    ].any((double value) => !value.isFinite)) {
      throw ArgumentError('Similarity parameters must be finite.');
    }
    final double radians = rotationDegrees * math.pi / 180;
    final double cosine = math.cos(radians);
    final double sine = math.sin(radians);
    return AffineSamplingTransform(
      m00: cosine,
      m01: -sine,
      m02: centerX - cosine * centerX + sine * centerY + sourceOffsetX,
      m10: sine,
      m11: cosine,
      m12: centerY - sine * centerX - cosine * centerY + sourceOffsetY,
    );
  }

  /// Creates one inverse sampling map for focus-stack alignment and focus
  /// breathing: isotropic scale + rotation + translation around [centerX/Y].
  factory AffineSamplingTransform.scaledSimilarity({
    required double scale,
    required double rotationDegrees,
    required double sourceOffsetX,
    required double sourceOffsetY,
    required double centerX,
    required double centerY,
  }) {
    if (<double>[
          scale,
          rotationDegrees,
          sourceOffsetX,
          sourceOffsetY,
          centerX,
          centerY,
        ].any((double value) => !value.isFinite) ||
        !(scale > 0)) {
      throw ArgumentError(
        'Scaled-similarity parameters must be finite and scale positive.',
      );
    }
    final double radians = rotationDegrees * math.pi / 180;
    final double cosine = math.cos(radians) * scale;
    final double sine = math.sin(radians) * scale;
    return AffineSamplingTransform(
      m00: cosine,
      m01: -sine,
      m02: centerX - cosine * centerX + sine * centerY + sourceOffsetX,
      m10: sine,
      m11: cosine,
      m12: centerY - sine * centerX - cosine * centerY + sourceOffsetY,
    );
  }

  final double m00;
  final double m01;
  final double m02;
  final double m10;
  final double m11;
  final double m12;

  /// Projective denominator coefficients (Work351). Zero for every
  /// affine/similarity transform.
  final double p20;
  final double p21;

  /// Whether the projective terms are in use.
  bool get isProjective => p20 != 0 || p21 != 0;

  /// The six (affine) or eight (projective) coefficients in a stable order
  /// for checkpoint binding. Affine transforms keep the historical 6-value
  /// form so that existing checkpoint fingerprints are unchanged.
  List<double> get checkpointCoefficients => isProjective
      ? <double>[m00, m01, m02, m10, m11, m12, p20, p21]
      : <double>[m00, m01, m02, m10, m11, m12];

  AffineSamplingTransform inverse() {
    if (isProjective) return _projectiveInverse();
    final double determinant = m00 * m11 - m01 * m10;
    if (!determinant.isFinite || determinant.abs() < 1e-15) {
      throw StateError('Affine transform is not invertible.');
    }
    return AffineSamplingTransform(
      m00: m11 / determinant,
      m01: -m01 / determinant,
      m02: (m01 * m12 - m11 * m02) / determinant,
      m10: -m10 / determinant,
      m11: m00 / determinant,
      m12: (m10 * m02 - m00 * m12) / determinant,
    );
  }

  AffineSamplingTransform _projectiveInverse() {
    // Inverse of [[m00,m01,m02],[m10,m11,m12],[p20,p21,1]] via the adjugate,
    // rescaled so that the (2,2) element is 1.
    final double a = m00, b = m01, c = m02;
    final double d = m10, e = m11, f = m12;
    final double g = p20, h = p21;
    const double i = 1;
    final double c00 = e * i - f * h;
    final double c01 = -(b * i - c * h);
    final double c02 = b * f - c * e;
    final double c10 = -(d * i - f * g);
    final double c11 = a * i - c * g;
    final double c12 = -(a * f - c * d);
    final double c20 = d * h - e * g;
    final double c21 = -(a * h - b * g);
    final double c22 = a * e - b * d;
    final double determinant = a * c00 + b * c10 + c * c20;
    if (!determinant.isFinite || determinant.abs() < 1e-15) {
      throw StateError('Affine transform is not invertible.');
    }
    if (!c22.isFinite || c22.abs() < 1e-15) {
      throw StateError('Affine transform is not invertible.');
    }
    return AffineSamplingTransform(
      m00: c00 / c22,
      m01: c01 / c22,
      m02: c02 / c22,
      m10: c10 / c22,
      m11: c11 / c22,
      m12: c12 / c22,
      p20: c20 / c22,
      p21: c21 / c22,
    );
  }

  double sourceX(double outputX, double outputY) {
    if (!isProjective) return m00 * outputX + m01 * outputY + m02;
    return (m00 * outputX + m01 * outputY + m02) /
        (p20 * outputX + p21 * outputY + 1);
  }

  double sourceY(double outputX, double outputY) {
    if (!isProjective) return m10 * outputX + m11 * outputY + m12;
    return (m10 * outputX + m11 * outputY + m12) /
        (p20 * outputX + p21 * outputY + 1);
  }
}
