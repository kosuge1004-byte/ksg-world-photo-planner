import 'dart:math' as math;

import '../registration/affine_sampling_transform.dart';

final class FocusAlignmentMatch {
  const FocusAlignmentMatch({
    required this.referenceX,
    required this.referenceY,
    required this.sourceX,
    required this.sourceY,
  });

  final double referenceX;
  final double referenceY;
  final double sourceX;
  final double sourceY;
}

final class FocusAlignmentEstimate {
  const FocusAlignmentEstimate({
    required this.scale,
    required this.rotationDegrees,
    required this.sourceOffsetX,
    required this.sourceOffsetY,
    required this.centerX,
    required this.centerY,
    required this.rmsResidual,
    required this.inlierCount,
  });

  final double scale;
  final double rotationDegrees;
  final double sourceOffsetX;
  final double sourceOffsetY;
  final double centerX;
  final double centerY;
  final double rmsResidual;
  final int inlierCount;

  AffineSamplingTransform toSamplingTransform() =>
      AffineSamplingTransform.scaledSimilarity(
        scale: scale,
        rotationDegrees: rotationDegrees,
        sourceOffsetX: sourceOffsetX,
        sourceOffsetY: sourceOffsetY,
        centerX: centerX,
        centerY: centerY,
      );
}

final class FocusAlignmentFailed implements Exception {
  const FocusAlignmentFailed(this.message);
  final String message;

  @override
  String toString() => 'FocusAlignmentFailed: $message';
}

/// Fits reference/output coordinates to source-frame coordinates with a
/// scaled-similarity model. This is deliberately limited to uniform scale,
/// rotation and translation so focus breathing can be corrected without
/// adding unnecessary geometric freedom.
///
/// Residual outliers are removed with one median/MAD pass, then the model is
/// refit. The rejection gate is derived from the observed residuals rather
/// than from a guessed fixed pixel threshold.
FocusAlignmentEstimate estimateFocusAlignment(
  List<FocusAlignmentMatch> matches, {
  int minimumInliers = 3,
}) {
  if (minimumInliers < 2) {
    throw ArgumentError.value(minimumInliers, 'minimumInliers');
  }
  if (matches.length < minimumInliers) {
    throw const FocusAlignmentFailed(
      'Not enough focus-alignment correspondences.',
    );
  }
  for (final FocusAlignmentMatch match in matches) {
    if (<double>[
      match.referenceX,
      match.referenceY,
      match.sourceX,
      match.sourceY,
    ].any((double value) => !value.isFinite)) {
      throw ArgumentError('Focus-alignment coordinates must be finite.');
    }
  }

  final _Fit initial = _fitScaledSimilarity(matches);
  final List<double> residuals = <double>[
    for (final FocusAlignmentMatch match in matches) _residual(initial, match),
  ];
  final double medianResidual = _median(residuals);
  final List<double> deviations = <double>[
    for (final double residual in residuals) (residual - medianResidual).abs(),
  ];
  final double mad = _median(deviations);
  // Zero MAD describes a concentrated majority, not unlimited uncertainty.
  // Allow round-off at the observed coordinate scale, while still rejecting
  // residuals above that majority. An infinite gate retained gross outliers.
  final double coordinateScale = matches.fold<double>(
      1,
      (double scale, FocusAlignmentMatch match) => math.max(
          scale,
          math.max(
              match.sourceX.abs(),
              math.max(match.sourceY.abs(),
                  math.max(match.referenceX.abs(), match.referenceY.abs())))));
  final double residualEpsilon = coordinateScale * 1e-12;
  final double gate =
      medianResidual + math.max(3 * 1.4826 * mad, residualEpsilon);

  final List<FocusAlignmentMatch> inliers = <FocusAlignmentMatch>[
    for (int index = 0; index < matches.length; index++)
      if (residuals[index] <= gate) matches[index],
  ];
  if (inliers.length < minimumInliers) {
    throw const FocusAlignmentFailed(
      'Robust focus alignment left too few correspondences.',
    );
  }

  final _Fit fit = inliers.length == matches.length
      ? initial
      : _fitScaledSimilarity(inliers);
  final double rms = _rmsResidual(fit, inliers);
  if (!rms.isFinite) {
    throw const FocusAlignmentFailed(
      'Focus alignment produced non-finite RMS.',
    );
  }

  return FocusAlignmentEstimate(
    scale: fit.scale,
    rotationDegrees: fit.rotationRadians * 180 / math.pi,
    sourceOffsetX: fit.sourceOffsetX,
    sourceOffsetY: fit.sourceOffsetY,
    centerX: fit.referenceCenterX,
    centerY: fit.referenceCenterY,
    rmsResidual: rms,
    inlierCount: inliers.length,
  );
}

final class _Fit {
  const _Fit({
    required this.scale,
    required this.rotationRadians,
    required this.sourceOffsetX,
    required this.sourceOffsetY,
    required this.referenceCenterX,
    required this.referenceCenterY,
  });

  final double scale;
  final double rotationRadians;
  final double sourceOffsetX;
  final double sourceOffsetY;
  final double referenceCenterX;
  final double referenceCenterY;
}

_Fit _fitScaledSimilarity(List<FocusAlignmentMatch> matches) {
  double refX = 0;
  double refY = 0;
  double srcX = 0;
  double srcY = 0;
  for (final FocusAlignmentMatch match in matches) {
    refX += match.referenceX;
    refY += match.referenceY;
    srcX += match.sourceX;
    srcY += match.sourceY;
  }
  final double n = matches.length.toDouble();
  refX /= n;
  refY /= n;
  srcX /= n;
  srcY /= n;

  double a = 0;
  double b = 0;
  double referenceEnergy = 0;
  for (final FocusAlignmentMatch match in matches) {
    final double rx = match.referenceX - refX;
    final double ry = match.referenceY - refY;
    final double sx = match.sourceX - srcX;
    final double sy = match.sourceY - srcY;
    a += rx * sx + ry * sy;
    b += rx * sy - ry * sx;
    referenceEnergy += rx * rx + ry * ry;
  }
  if (!(referenceEnergy > 0) || !referenceEnergy.isFinite) {
    throw const FocusAlignmentFailed(
      'Focus-alignment reference points have no spatial extent.',
    );
  }

  final double magnitude = math.sqrt(a * a + b * b);
  final double scale = magnitude / referenceEnergy;
  if (!scale.isFinite || !(scale > 0)) {
    throw const FocusAlignmentFailed(
      'Focus alignment produced an invalid scale.',
    );
  }
  final double rotation = math.atan2(b, a);

  // The center-relative offset equals source centroid minus reference centroid.
  // This keeps the transform in the exact parameterization expected by
  // AffineSamplingTransform.scaledSimilarity.
  final double offsetX = srcX - refX;
  final double offsetY = srcY - refY;

  return _Fit(
    scale: scale,
    rotationRadians: rotation,
    sourceOffsetX: offsetX,
    sourceOffsetY: offsetY,
    referenceCenterX: refX,
    referenceCenterY: refY,
  );
}

double _residual(_Fit fit, FocusAlignmentMatch match) {
  final double c = math.cos(fit.rotationRadians) * fit.scale;
  final double s = math.sin(fit.rotationRadians) * fit.scale;
  final double dx = match.referenceX - fit.referenceCenterX;
  final double dy = match.referenceY - fit.referenceCenterY;
  final double predictedX =
      fit.referenceCenterX + c * dx - s * dy + fit.sourceOffsetX;
  final double predictedY =
      fit.referenceCenterY + s * dx + c * dy + fit.sourceOffsetY;
  final double ex = predictedX - match.sourceX;
  final double ey = predictedY - match.sourceY;
  return math.sqrt(ex * ex + ey * ey);
}

double _rmsResidual(_Fit fit, List<FocusAlignmentMatch> matches) {
  double sumSquares = 0;
  for (final FocusAlignmentMatch match in matches) {
    final double residual = _residual(fit, match);
    sumSquares += residual * residual;
  }
  return math.sqrt(sumSquares / matches.length);
}

double _median(List<double> values) {
  if (values.isEmpty) {
    throw ArgumentError('Median requires at least one value.');
  }
  final List<double> sorted = List<double>.from(values)..sort();
  final int middle = sorted.length ~/ 2;
  if (sorted.length.isOdd) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) * 0.5;
}
