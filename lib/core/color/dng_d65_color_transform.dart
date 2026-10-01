import 'linear_rgb_color_transform.dart';

class InvalidDngColorTransformInput extends ArgumentError {
  InvalidDngColorTransformInput(String super.message);
}

/// D65 XYZ to linear sRGB, using the IEC 61966-2-1/BT.709 primaries.
const List<double> d65XyzToLinearSrgb = <double>[
  3.2409699419045226,
  -1.537383177570094,
  -0.4986107602930034,
  -0.9692436362808796,
  1.8759675015077202,
  0.04155505740717559,
  0.05563007969699366,
  -0.20397695888897652,
  1.0569715142428786,
];

/// D50 XYZ to linear ProPhoto RGB (RIMM).
///
/// DNG ProfileHueSatMap/ProfileLookTable processing is defined in this
/// working space, not in linear sRGB.
const List<double> d50XyzToLinearProPhoto = <double>[
  1.3459433,
  -0.2556075,
  -0.0511118,
  -0.5445989,
  1.5081673,
  0.0205351,
  0.0,
  0.0,
  1.2118128,
];

/// Linear ProPhoto RGB (RIMM) to D50 XYZ.
const List<double> linearProPhotoToD50Xyz = <double>[
  0.797674944,
  0.135191701,
  0.031353354,
  0.288040238,
  0.711874097,
  0.000085665,
  0.0,
  0.0,
  0.825210000,
];

/// Builds the transform for a DNG `ColorMatrix1` or `ColorMatrix2` whose
/// corresponding calibration illuminant is D65.
///
/// DNG ColorMatrix maps XYZ to camera RGB. Mobile Stack white-balances the
/// mosaic before demosaic, so the actual demosaiced vector is
/// `diag(cameraWhiteBalanceRgb) * xyzToCameraD65 * XYZ`. Inverting that
/// composite recovers XYZ under the as-shot white. The as-shot white is
/// reconstructed from CameraNeutral, then adapted to D65 with the linear
/// Bradford method before applying D65 XYZ -> linear sRGB.
///
/// This function intentionally accepts only a matrix already identified as
/// D65 by the metadata layer. A matrix for illuminant A/D50 cannot be made
/// correct merely by labeling it D65; it needs chromatic adaptation or dual-
/// illuminant interpolation first.
LinearRgbColorTransform linearSrgbTransformFromDngD65({
  required List<double> xyzToCameraD65,
  required List<double> cameraWhiteBalanceRgb,
}) {
  final List<double> cameraToD65Xyz = _cameraToAdaptedXyzFromDngD65(
    xyzToCameraD65: xyzToCameraD65,
    cameraWhiteBalanceRgb: cameraWhiteBalanceRgb,
    destinationWhiteXyz: _d65WhiteXyz,
  );
  return LinearRgbColorTransform(
    matrix: _multiply3x3(d65XyzToLinearSrgb, cameraToD65Xyz),
    sourceDescription: 'white-balanced DNG camera RGB',
    destinationDescription: 'linear sRGB (D65)',
  );
}

/// Same DNG D65 camera conversion as [linearSrgbTransformFromDngD65], but
/// stops in linear ProPhoto RGB / RIMM (D50), as required before applying
/// DNG ProfileHueSatMap/ProfileLookTable.
LinearRgbColorTransform linearProPhotoTransformFromDngD65({
  required List<double> xyzToCameraD65,
  required List<double> cameraWhiteBalanceRgb,
}) {
  final List<double> cameraToD50Xyz = _cameraToAdaptedXyzFromDngD65(
    xyzToCameraD65: xyzToCameraD65,
    cameraWhiteBalanceRgb: cameraWhiteBalanceRgb,
    destinationWhiteXyz: _d50WhiteXyz,
  );
  return LinearRgbColorTransform(
    matrix: _multiply3x3(d50XyzToLinearProPhoto, cameraToD50Xyz),
    sourceDescription: 'white-balanced DNG camera RGB',
    destinationDescription: 'linear ProPhoto RGB (D50/RIMM)',
  );
}

/// Converts the DNG profile working space back to this application's final
/// linear-sRGB/D65 working space after ProfileHueSatMap/ProfileLookTable.
LinearRgbColorTransform linearSrgbTransformFromLinearProPhoto() {
  final List<double> d50ToD65 = _linearBradfordAdaptation(
    _d50WhiteXyz,
    _d65WhiteXyz,
  );
  return LinearRgbColorTransform(
    matrix: _multiply3x3(
      d65XyzToLinearSrgb,
      _multiply3x3(d50ToD65, linearProPhotoToD50Xyz),
    ),
    sourceDescription: 'linear ProPhoto RGB (D50/RIMM)',
    destinationDescription: 'linear sRGB (D65)',
  );
}

List<double> _cameraToAdaptedXyzFromDngD65({
  required List<double> xyzToCameraD65,
  required List<double> cameraWhiteBalanceRgb,
  required List<double> destinationWhiteXyz,
}) {
  _validateFiniteLength(xyzToCameraD65, 9, 'xyzToCameraD65');
  _validateFiniteLength(cameraWhiteBalanceRgb, 3, 'cameraWhiteBalanceRgb');
  _validateFiniteLength(destinationWhiteXyz, 3, 'destinationWhiteXyz');
  if (cameraWhiteBalanceRgb.any((double value) => value <= 0)) {
    throw InvalidDngColorTransformInput(
      'cameraWhiteBalanceRgb must contain positive gains.',
    );
  }
  final List<double> whiteBalancedXyzToCamera = <double>[
    for (int row = 0; row < 3; row++)
      for (int column = 0; column < 3; column++)
        cameraWhiteBalanceRgb[row] * xyzToCameraD65[row * 3 + column],
  ];
  final List<double> cameraToAsShotXyz = _inverse3x3(
    whiteBalancedXyzToCamera,
  );
  final List<double> cameraNeutral = <double>[
    for (final double gain in cameraWhiteBalanceRgb) 1 / gain,
  ];
  final List<double> xyzToCameraInverse = _inverse3x3(xyzToCameraD65);
  final List<double> asShotWhiteXyz = _multiply3x3Vector(
    xyzToCameraInverse,
    cameraNeutral,
  );
  if (asShotWhiteXyz.any((double value) => !value.isFinite || value < 0) ||
      asShotWhiteXyz[1] <= 0) {
    throw InvalidDngColorTransformInput(
      'CameraNeutral does not map to a valid as-shot XYZ white point.',
    );
  }
  final double whiteY = asShotWhiteXyz[1];
  final List<double> normalizedAsShotWhite = <double>[
    for (final double value in asShotWhiteXyz) value / whiteY,
  ];
  final List<double> adaptation = _linearBradfordAdaptation(
    normalizedAsShotWhite,
    destinationWhiteXyz,
  );
  return _multiply3x3(adaptation, cameraToAsShotXyz);
}

const List<double> _d50WhiteXyz = <double>[
  0.96422,
  1,
  0.82521,
];

const List<double> _d65WhiteXyz = <double>[
  0.3127 / 0.3290,
  1,
  (1 - 0.3127 - 0.3290) / 0.3290,
];

const List<double> _linearBradford = <double>[
  0.8951,
  0.2664,
  -0.1614,
  -0.7502,
  1.7135,
  0.0367,
  0.0389,
  -0.0685,
  1.0296,
];

List<double> _linearBradfordAdaptation(
  List<double> sourceWhiteXyz,
  List<double> destinationWhiteXyz,
) {
  if (_sameWhitePoint(sourceWhiteXyz, destinationWhiteXyz)) {
    return const <double>[1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
  final List<double> rawSourceCone =
      _multiply3x3Vector(_linearBradford, sourceWhiteXyz);
  final List<double> rawDestinationCone =
      _multiply3x3Vector(_linearBradford, destinationWhiteXyz);
  if (rawSourceCone.any((double value) => !value.isFinite) ||
      rawDestinationCone.any((double value) => !value.isFinite)) {
    throw InvalidDngColorTransformInput(
      'White points cannot be adapted with linear Bradford.',
    );
  }
  final List<double> sourceCone = <double>[
    for (final double value in rawSourceCone) value < 0 ? 0 : value,
  ];
  final List<double> destinationCone = <double>[
    for (final double value in rawDestinationCone) value < 0 ? 0 : value,
  ];
  final List<double> scaledBradford = <double>[
    for (int row = 0; row < 3; row++)
      for (int column = 0; column < 3; column++)
        _clampBradfordScale(
              sourceCone[row] > 0 ? destinationCone[row] / sourceCone[row] : 10,
            ) *
            _linearBradford[row * 3 + column],
  ];
  return _multiply3x3(_inverse3x3(_linearBradford), scaledBradford);
}

bool _sameWhitePoint(List<double> left, List<double> right) {
  for (int index = 0; index < 3; index++) {
    if ((left[index] - right[index]).abs() > 3e-4) return false;
  }
  return true;
}

double _clampBradfordScale(double value) => value.clamp(0.1, 10).toDouble();

List<double> _multiply3x3Vector(List<double> matrix, List<double> vector) =>
    <double>[
      for (int row = 0; row < 3; row++)
        matrix[row * 3] * vector[0] +
            matrix[row * 3 + 1] * vector[1] +
            matrix[row * 3 + 2] * vector[2],
    ];

void _validateFiniteLength(List<double> values, int length, String name) {
  if (values.length != length ||
      values.any((double value) => !value.isFinite)) {
    throw InvalidDngColorTransformInput(
      '$name must contain exactly $length finite values.',
    );
  }
}

List<double> _multiply3x3(List<double> left, List<double> right) => <double>[
      for (int row = 0; row < 3; row++)
        for (int column = 0; column < 3; column++)
          left[row * 3] * right[column] +
              left[row * 3 + 1] * right[3 + column] +
              left[row * 3 + 2] * right[6 + column],
    ];

List<double> _inverse3x3(List<double> matrix) {
  final double a = matrix[0];
  final double b = matrix[1];
  final double c = matrix[2];
  final double d = matrix[3];
  final double e = matrix[4];
  final double f = matrix[5];
  final double g = matrix[6];
  final double h = matrix[7];
  final double i = matrix[8];
  final double cofactor00 = e * i - f * h;
  final double determinant =
      a * cofactor00 + b * (f * g - d * i) + c * (d * h - e * g);
  final double scale = matrix.fold<double>(
    0,
    (double maximum, double value) =>
        value.abs() > maximum ? value.abs() : maximum,
  );
  final double relativeThreshold = scale * scale * scale * 1e-12;
  if (!determinant.isFinite || determinant.abs() <= relativeThreshold) {
    throw InvalidDngColorTransformInput(
      'DNG color matrix is singular or numerically ill-conditioned.',
    );
  }
  final double inverseDeterminant = 1 / determinant;
  final List<double> inverse = <double>[
    cofactor00 * inverseDeterminant,
    (c * h - b * i) * inverseDeterminant,
    (b * f - c * e) * inverseDeterminant,
    (f * g - d * i) * inverseDeterminant,
    (a * i - c * g) * inverseDeterminant,
    (c * d - a * f) * inverseDeterminant,
    (d * h - e * g) * inverseDeterminant,
    (b * g - a * h) * inverseDeterminant,
    (a * e - b * d) * inverseDeterminant,
  ];
  if (inverse.any((double value) => !value.isFinite)) {
    throw InvalidDngColorTransformInput(
      'DNG color matrix inverse contains non-finite values.',
    );
  }
  final double matrixInfinityNorm = _matrixInfinityNorm(matrix);
  final double inverseInfinityNorm = _matrixInfinityNorm(inverse);
  final double conditionNumber = matrixInfinityNorm * inverseInfinityNorm;
  if (!conditionNumber.isFinite ||
      conditionNumber > _maximumColorMatrixConditionNumber) {
    throw InvalidDngColorTransformInput(
      'DNG color matrix is too ill-conditioned for stable color conversion.',
    );
  }
  return inverse;
}

double _matrixInfinityNorm(List<double> matrix) {
  double maximum = 0;
  for (int row = 0; row < 3; row++) {
    final double rowSum = matrix[row * 3].abs() +
        matrix[row * 3 + 1].abs() +
        matrix[row * 3 + 2].abs();
    if (rowSum > maximum) maximum = rowSum;
  }
  return maximum;
}

const double _maximumColorMatrixConditionNumber = 1e6;
