import 'dart:math' as math;

import 'affine_sampling_transform.dart';
import 'star_detector.dart' show DetectedStar;
import 'star_transform_estimator.dart' show StarMatch;

/// Dart port of `tool/raw_samples/local_residual_correction_
/// reference.mjs`.
///
/// Addresses S5 of the quality specification this project's stakeholder
/// provided: layering a local, position-dependent residual correction
/// on top of the existing global similarity transform
/// (`star_transform_estimator.dart`), for effects (mild lens distortion,
/// gentle optical-system flexure) that leave systematically
/// spatially-varying residuals even after the best possible single
/// global transform.
///
/// See the Node reference's own doc comment for the full design
/// rationale, including why a low-degree (2) 2-D polynomial fit was
/// chosen specifically — a fixed, low-degree polynomial is structurally
/// incapable of the "excessive warping" the person who requested this
/// feature explicitly warned against, unlike a purely local
/// interpolation that could fit to individual noisy measurements.
///
/// This file has not been executed against the Dart SDK. It is a
/// careful line-by-line translation of the Node reference, which has
/// full test coverage, including a hand-verified numeric case (a known
/// quadratic residual field, confirming the fit recovers the exact
/// underlying function). Run `test/local_residual_correction_test.dart`
/// before relying on this in production.

class InvalidLocalResidualFitInput extends ArgumentError {
  InvalidLocalResidualFitInput(String super.message);
}

/// One matched star pair's own residual after the global transform has
/// already been applied: [residualX]/[residualY] is how far the
/// globally-transformed [referenceX]/[referenceY] position still
/// differs from the actual target position.
class LocalResidualMatch {
  const LocalResidualMatch({
    required this.referenceX,
    required this.referenceY,
    required this.residualX,
    required this.residualY,
  });

  final double referenceX;
  final double referenceY;
  final double residualX;
  final double residualY;
}

/// A single evaluated correction vector, returned by
/// [LocalResidualCorrectionField.evaluate].
class LocalResidualCorrection {
  const LocalResidualCorrection({required this.dx, required this.dy});

  final double dx;
  final double dy;
}

const int _basisTermCount = 6;

List<double> _polynomialBasis(double x, double y) {
  return <double>[1, x, y, x * x, x * y, y * y];
}

/// The fitted (or empty) local residual correction field returned by
/// [fitLocalResidualCorrectionField].
class LocalResidualCorrectionField {
  const LocalResidualCorrectionField._({
    required List<double>? coefficientsX,
    required List<double>? coefficientsY,
    required this.maximumCorrectionMagnitude,
    required this.fitted,
    this.centerX = 0,
    this.centerY = 0,
    this.scaleX = 1,
    this.scaleY = 1,
  })  : _coefficientsX = coefficientsX,
        _coefficientsY = coefficientsY;

  final List<double>? _coefficientsX;
  final List<double>? _coefficientsY;
  final double maximumCorrectionMagnitude;

  /// Coordinate normalization applied before evaluating the polynomial
  /// (Work124, addressing a real numerical-stability risk found by
  /// self-audit): raw image coordinates (potentially thousands of
  /// pixels) fed directly into a degree-2 polynomial basis produce
  /// squared terms differing from the constant term by 14+ orders of
  /// magnitude — uncomfortably close to double's own ~15-17 significant
  /// digits, risking numerically unstable fits for irregularly-
  /// distributed star positions. Normalizing to roughly `[-1, 1]` before
  /// fitting (and before every [evaluate] call) keeps the underlying
  /// least-squares system well-conditioned regardless of the actual
  /// image resolution. This does not change *what function* is fitted —
  /// only the numerically-stable basis it is expressed in — so
  /// [evaluate]'s own output is mathematically unaffected.
  final double centerX;
  final double centerY;
  final double scaleX;
  final double scaleY;

  /// `false` when this field is the always-zero fallback (too few
  /// matches, or the underlying least-squares fit failed); `true` when
  /// a genuine fit was used.
  final bool fitted;

  Map<String, Object?> toCheckpointJson() => {
        'x': _coefficientsX,
        'y': _coefficientsY,
        'centerX': centerX,
        'centerY': centerY,
        'scaleX': scaleX,
        'scaleY': scaleY,
        'maximumCorrectionMagnitude': maximumCorrectionMagnitude,
        'fitted': fitted,
      };

  LocalResidualCorrection evaluate(double x, double y) {
    if (!x.isFinite || !y.isFinite) {
      throw InvalidLocalResidualFitInput(
        'Local residual evaluation coordinates must be finite.',
      );
    }
    if (!fitted) return const LocalResidualCorrection(dx: 0, dy: 0);
    return _evaluateFittedCorrection(
      x: x,
      y: y,
      centerX: centerX,
      centerY: centerY,
      scaleX: scaleX,
      scaleY: scaleY,
      coefficientsX: _coefficientsX!,
      coefficientsY: _coefficientsY!,
      maximumCorrectionMagnitude: maximumCorrectionMagnitude,
    );
  }
}

/// Solves the square linear system `matrix * solution = vector` via
/// Gaussian elimination with partial pivoting.
///
/// Throws [InvalidLocalResidualFitInput] if [matrix] is singular (or
/// numerically indistinguishable from singular).
List<double> _solveLinearSystem(
  List<List<double>> matrix,
  List<double> vector,
) {
  final int n = matrix.length;
  final List<List<double>> augmented = <List<double>>[
    for (int i = 0; i < n; i++) <double>[...matrix[i], vector[i]],
  ];

  for (int pivotColumn = 0; pivotColumn < n; pivotColumn++) {
    int pivotRow = pivotColumn;
    double pivotMagnitude = augmented[pivotColumn][pivotColumn].abs();
    for (int row = pivotColumn + 1; row < n; row++) {
      final double magnitude = augmented[row][pivotColumn].abs();
      if (magnitude > pivotMagnitude) {
        pivotRow = row;
        pivotMagnitude = magnitude;
      }
    }
    if (pivotMagnitude < 1e-12) {
      throw InvalidLocalResidualFitInput(
        'Matrix is singular; cannot fit local residual polynomial.',
      );
    }
    if (pivotRow != pivotColumn) {
      final List<double> swap = augmented[pivotColumn];
      augmented[pivotColumn] = augmented[pivotRow];
      augmented[pivotRow] = swap;
    }
    final double pivotValue = augmented[pivotColumn][pivotColumn];
    for (int row = pivotColumn + 1; row < n; row++) {
      final double factor = augmented[row][pivotColumn] / pivotValue;
      if (factor == 0) continue;
      for (int column = pivotColumn; column <= n; column++) {
        augmented[row][column] -= factor * augmented[pivotColumn][column];
      }
    }
  }

  final List<double> solution = List<double>.filled(n, 0);
  for (int row = n - 1; row >= 0; row--) {
    double sum = augmented[row][n];
    for (int column = row + 1; column < n; column++) {
      sum -= augmented[row][column] * solution[column];
    }
    solution[row] = sum / augmented[row][row];
  }
  return solution;
}

double _medianDouble(List<double> values) {
  final List<double> sorted = List<double>.of(values)..sort();
  final int middle = sorted.length >> 1;
  return sorted.length.isOdd
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
}

List<int> _robustLocalResidualSurvivors({
  required List<({double x, double y})> points,
  required List<double> residualXValues,
  required List<double> residualYValues,
  required List<double> coefficientsX,
  required List<double> coefficientsY,
  required int minimumSurvivors,
}) {
  final List<double> errors = <double>[];
  for (int i = 0; i < points.length; i++) {
    final List<double> basis = _polynomialBasis(points[i].x, points[i].y);
    double predictedX = 0;
    double predictedY = 0;
    for (int term = 0; term < _basisTermCount; term++) {
      predictedX += basis[term] * coefficientsX[term];
      predictedY += basis[term] * coefficientsY[term];
    }
    final double dx = residualXValues[i] - predictedX;
    final double dy = residualYValues[i] - predictedY;
    errors.add(math.sqrt(dx * dx + dy * dy));
  }
  final double center = _medianDouble(errors);
  final List<double> deviations = <double>[
    for (final double error in errors) (error - center).abs(),
  ];
  final double mad = _medianDouble(deviations);
  final double sigma = mad * 1.4826;
  final double tolerance = sigma > 0
      ? center + 4.5 * sigma
      : center + 1e-9 * math.max(1.0, center.abs());
  final List<int> survivors = <int>[
    for (int i = 0; i < errors.length; i++)
      if (errors[i] <= tolerance) i,
  ];
  return survivors.length >= minimumSurvivors
      ? survivors
      : List<int>.generate(points.length, (int i) => i);
}

LocalResidualCorrection _evaluateFittedCorrection({
  required double x,
  required double y,
  required double centerX,
  required double centerY,
  required double scaleX,
  required double scaleY,
  required List<double> coefficientsX,
  required List<double> coefficientsY,
  required double maximumCorrectionMagnitude,
}) {
  final double normalizedX = (x - centerX) / scaleX;
  final double normalizedY = (y - centerY) / scaleY;
  final List<double> basis = _polynomialBasis(normalizedX, normalizedY);
  double dx = 0;
  double dy = 0;
  for (int i = 0; i < _basisTermCount; i++) {
    dx += basis[i] * coefficientsX[i];
    dy += basis[i] * coefficientsY[i];
  }
  if (!dx.isFinite || !dy.isFinite) {
    throw InvalidLocalResidualFitInput(
      'Local residual correction produced a non-finite value.',
    );
  }
  final double magnitude = math.sqrt(dx * dx + dy * dy);
  if (!magnitude.isFinite) {
    throw InvalidLocalResidualFitInput(
      'Local residual correction magnitude is non-finite.',
    );
  }
  if (magnitude > maximumCorrectionMagnitude) {
    final double scale = maximumCorrectionMagnitude / magnitude;
    dx *= scale;
    dy *= scale;
  }
  return LocalResidualCorrection(dx: dx, dy: dy);
}

bool _fitDoesNotWorsenMatchedRms({
  required List<LocalResidualMatch> matches,
  required double centerX,
  required double centerY,
  required double scaleX,
  required double scaleY,
  required List<double> coefficientsX,
  required List<double> coefficientsY,
  required double maximumCorrectionMagnitude,
}) {
  double globalSquaredError = 0;
  double correctedSquaredError = 0;
  for (final LocalResidualMatch match in matches) {
    globalSquaredError +=
        match.residualX * match.residualX + match.residualY * match.residualY;
    final LocalResidualCorrection correction = _evaluateFittedCorrection(
      x: match.referenceX,
      y: match.referenceY,
      centerX: centerX,
      centerY: centerY,
      scaleX: scaleX,
      scaleY: scaleY,
      coefficientsX: coefficientsX,
      coefficientsY: coefficientsY,
      maximumCorrectionMagnitude: maximumCorrectionMagnitude,
    );
    final double dx = match.residualX - correction.dx;
    final double dy = match.residualY - correction.dy;
    correctedSquaredError += dx * dx + dy * dy;
  }
  final double tolerance = 1e-12 * math.max(1.0, globalSquaredError);
  return correctedSquaredError <= globalSquaredError + tolerance;
}

List<double> _fitPolynomialLeastSquares(
  List<({double x, double y})> points,
  List<double> targetValues,
) {
  final List<List<double>> normalMatrix = <List<double>>[
    for (int i = 0; i < _basisTermCount; i++)
      List<double>.filled(_basisTermCount, 0),
  ];
  final List<double> normalVector = List<double>.filled(_basisTermCount, 0);

  for (int i = 0; i < points.length; i++) {
    final List<double> basis = _polynomialBasis(points[i].x, points[i].y);
    for (int row = 0; row < _basisTermCount; row++) {
      normalVector[row] += basis[row] * targetValues[i];
      for (int column = 0; column < _basisTermCount; column++) {
        normalMatrix[row][column] += basis[row] * basis[column];
      }
    }
  }

  return _solveLinearSystem(normalMatrix, normalVector);
}

/// Fits a local residual correction field from [matches] — see this
/// file's own doc comment for the full design.
///
/// - [minimumMatchesPerCoefficient] (default `4`): with
///   `matches.length < 6 * minimumMatchesPerCoefficient`, returns a
///   field whose [LocalResidualCorrectionField.evaluate] always returns
///   a zero correction.
/// - [maximumCorrectionMagnitude] (default `3`): the returned field's
///   own evaluate clamps its output vector's magnitude to this value.
///
/// Throws [InvalidLocalResidualFitInput] if
/// [minimumMatchesPerCoefficient] or [maximumCorrectionMagnitude] is not
/// positive.
LocalResidualCorrectionField fitLocalResidualCorrectionField(
  List<LocalResidualMatch> matches, {
  double minimumMatchesPerCoefficient = 4,
  double maximumCorrectionMagnitude = 3,
}) {
  if (!(minimumMatchesPerCoefficient > 0)) {
    throw InvalidLocalResidualFitInput(
      'minimumMatchesPerCoefficient must be positive.',
    );
  }
  if (!(maximumCorrectionMagnitude > 0)) {
    throw InvalidLocalResidualFitInput(
      'maximumCorrectionMagnitude must be positive.',
    );
  }
  for (final LocalResidualMatch match in matches) {
    if (!match.referenceX.isFinite ||
        !match.referenceY.isFinite ||
        !match.residualX.isFinite ||
        !match.residualY.isFinite) {
      throw InvalidLocalResidualFitInput(
        'Local residual matches must contain only finite values.',
      );
    }
  }

  LocalResidualCorrectionField zeroField() => LocalResidualCorrectionField._(
        coefficientsX: null,
        coefficientsY: null,
        maximumCorrectionMagnitude: maximumCorrectionMagnitude,
        fitted: false,
      );

  final double minimumMatches = _basisTermCount * minimumMatchesPerCoefficient;
  if (matches.length < minimumMatches) {
    return zeroField();
  }

  // 座標を正規化してからフィットする(Work124で発見・修正): 詳細は
  // [LocalResidualCorrectionField]自身のドキュメントコメント参照。
  final List<double> referenceXValues = <double>[
    for (final LocalResidualMatch m in matches) m.referenceX,
  ];
  final List<double> referenceYValues = <double>[
    for (final LocalResidualMatch m in matches) m.referenceY,
  ];
  final double minX = referenceXValues.reduce(math.min);
  final double maxX = referenceXValues.reduce(math.max);
  final double minY = referenceYValues.reduce(math.min);
  final double maxY = referenceYValues.reduce(math.max);
  final double centerX = (minX + maxX) / 2;
  final double centerY = (minY + maxY) / 2;
  // スケールが0(全点が同じx、または同じy)になるのを避けるため、
  // 最低でも1を使う(ゼロ除算の防止)。
  final double scaleX = math.max(1, (maxX - minX) / 2);
  final double scaleY = math.max(1, (maxY - minY) / 2);

  final List<({double x, double y})> points = <({double x, double y})>[
    for (final LocalResidualMatch m in matches)
      (
        x: (m.referenceX - centerX) / scaleX,
        y: (m.referenceY - centerY) / scaleY
      ),
  ];
  final List<double> residualXValues = <double>[
    for (final LocalResidualMatch m in matches) m.residualX,
  ];
  final List<double> residualYValues = <double>[
    for (final LocalResidualMatch m in matches) m.residualY,
  ];

  List<double> coefficientsX;
  List<double> coefficientsY;
  try {
    coefficientsX = _fitPolynomialLeastSquares(points, residualXValues);
    coefficientsY = _fitPolynomialLeastSquares(points, residualYValues);

    // One robust re-fit pass protects the spatial correction from a small
    // number of mismatched stars. The first low-degree fit establishes the
    // smooth field; residual-vector error is then MAD-clipped and the same
    // polynomial is re-fit from the surviving matches. If clipping would
    // leave too few constraints, the original all-match fit is retained.
    final List<int> survivorIndices = _robustLocalResidualSurvivors(
      points: points,
      residualXValues: residualXValues,
      residualYValues: residualYValues,
      coefficientsX: coefficientsX,
      coefficientsY: coefficientsY,
      minimumSurvivors: minimumMatches.ceil(),
    );
    if (survivorIndices.length < points.length) {
      coefficientsX = _fitPolynomialLeastSquares(
        <({double x, double y})>[
          for (final int i in survivorIndices) points[i]
        ],
        <double>[for (final int i in survivorIndices) residualXValues[i]],
      );
      coefficientsY = _fitPolynomialLeastSquares(
        <({double x, double y})>[
          for (final int i in survivorIndices) points[i]
        ],
        <double>[for (final int i in survivorIndices) residualYValues[i]],
      );
    }
  } on InvalidLocalResidualFitInput {
    return zeroField();
  }

  if (coefficientsX.any((double value) => !value.isFinite) ||
      coefficientsY.any((double value) => !value.isFinite)) {
    return zeroField();
  }
  // A local warp is optional refinement. Never accept it when the actual
  // clamped correction would increase RMS error on the matched stars that
  // established the global transform; falling back to the global transform
  // is strictly safer in that case and requires no empirical threshold.
  if (!_fitDoesNotWorsenMatchedRms(
    matches: matches,
    centerX: centerX,
    centerY: centerY,
    scaleX: scaleX,
    scaleY: scaleY,
    coefficientsX: coefficientsX,
    coefficientsY: coefficientsY,
    maximumCorrectionMagnitude: maximumCorrectionMagnitude,
  )) {
    return zeroField();
  }
  return LocalResidualCorrectionField._(
    coefficientsX: coefficientsX,
    coefficientsY: coefficientsY,
    maximumCorrectionMagnitude: maximumCorrectionMagnitude,
    fitted: true,
    centerX: centerX,
    centerY: centerY,
    scaleX: scaleX,
    scaleY: scaleY,
  );
}

/// Builds [LocalResidualMatch] entries from [matches] (typically
/// `StarSimilarityTransformEstimate.matches`) by comparing each match's
/// own actual target-frame position against where [globalTransform]
/// (typically built via `AffineSamplingTransform.similarity` from that
/// same estimate's own `rotationDegrees`/`sourceOffsetX`/
/// `sourceOffsetY`/`centerX`/`centerY`) predicts it should land, given
/// the reference-frame position alone.
///
/// This is the bridge between this project's existing registration
/// output (`star_transform_estimator.dart`) and
/// [fitLocalResidualCorrectionField]'s own input shape — it does not
/// modify or reinterpret [matches]/[globalTransform] in any way, only
/// reads from them.
///
/// [referenceStars]/[targetStars] must be the same lists
/// `estimateSimilarityTransform` itself was called with (`matches`'
/// own `referenceIndex`/`targetIndex` are indices into exactly those
/// lists).

/// Computes the RMS residual that remains after applying [field] to the
/// already-global-registration residual vectors in [matches].
///
/// This measures the registration error of the transform that is actually
/// sampled by the RGB/CFA stacker (global similarity plus optional local
/// correction), rather than the pre-local global fit alone. An empty match
/// list is invalid because an RMS quality metric without observations is
/// undefined.
double localResidualCorrectedRms(
  List<LocalResidualMatch> matches,
  LocalResidualCorrectionField? field,
) {
  if (matches.isEmpty) {
    throw InvalidLocalResidualFitInput(
      'At least one local residual match is required to compute RMS.',
    );
  }
  double squaredError = 0;
  for (final LocalResidualMatch match in matches) {
    final LocalResidualCorrection correction =
        field?.evaluate(match.referenceX, match.referenceY) ??
            const LocalResidualCorrection(dx: 0, dy: 0);
    final double dx = match.residualX - correction.dx;
    final double dy = match.residualY - correction.dy;
    squaredError += dx * dx + dy * dy;
  }
  final double rms = math.sqrt(squaredError / matches.length);
  if (!rms.isFinite || rms < 0) {
    throw InvalidLocalResidualFitInput(
      'Corrected local residual RMS is non-finite.',
    );
  }
  return rms;
}

/// Distribution-level registration diagnostics for the residual vectors that
/// remain after the global similarity transform and an optional local field.
/// RMS alone can hide a small tail of badly aligned stars; these metrics keep
/// that tail and any coherent residual direction visible to the quality gate.
final class LocalResidualStatistics {
  const LocalResidualStatistics({
    required this.count,
    required this.rms,
    required this.meanMagnitude,
    required this.medianMagnitude,
    required this.p90Magnitude,
    required this.p95Magnitude,
    required this.maxMagnitude,
    required this.meanDx,
    required this.meanDy,
    required this.meanVectorMagnitude,
    required this.directionalCoherence,
  });

  final int count;
  final double rms;
  final double meanMagnitude;
  final double medianMagnitude;
  final double p90Magnitude;
  final double p95Magnitude;
  final double maxMagnitude;
  final double meanDx;
  final double meanDy;
  final double meanVectorMagnitude;

  /// 0 means residual directions cancel completely; 1 means all residual
  /// vectors point in the same direction. It is a diagnostic, not a standalone
  /// proof of bad registration.
  final double directionalCoherence;
}

double _residualPercentile(List<double> sorted, double fraction) {
  if (sorted.isEmpty) {
    throw InvalidLocalResidualFitInput(
      'Residual percentile requires at least one observation.',
    );
  }
  if (sorted.length == 1) return sorted.first;
  final double position = fraction * (sorted.length - 1);
  final int lower = position.floor();
  final int upper = position.ceil();
  if (lower == upper) return sorted[lower];
  final double t = position - lower;
  return sorted[lower] * (1 - t) + sorted[upper] * t;
}

LocalResidualStatistics summarizeLocalResiduals(
  List<LocalResidualMatch> matches,
  LocalResidualCorrectionField? field,
) {
  if (matches.isEmpty) {
    throw InvalidLocalResidualFitInput(
      'At least one local residual match is required to summarize residuals.',
    );
  }
  final List<double> magnitudes = <double>[];
  double squaredError = 0;
  double sumMagnitude = 0;
  double sumDx = 0;
  double sumDy = 0;
  for (final LocalResidualMatch match in matches) {
    final LocalResidualCorrection correction =
        field?.evaluate(match.referenceX, match.referenceY) ??
            const LocalResidualCorrection(dx: 0, dy: 0);
    final double dx = match.residualX - correction.dx;
    final double dy = match.residualY - correction.dy;
    final double magnitude = math.sqrt(dx * dx + dy * dy);
    if (!dx.isFinite || !dy.isFinite || !magnitude.isFinite) {
      throw InvalidLocalResidualFitInput(
        'Corrected local residual contains non-finite values.',
      );
    }
    magnitudes.add(magnitude);
    squaredError += magnitude * magnitude;
    sumMagnitude += magnitude;
    sumDx += dx;
    sumDy += dy;
  }
  magnitudes.sort();
  final double count = matches.length.toDouble();
  final double rms = math.sqrt(squaredError / count);
  final double meanMagnitude = sumMagnitude / count;
  final double meanDx = sumDx / count;
  final double meanDy = sumDy / count;
  final double meanVectorMagnitude =
      math.sqrt(meanDx * meanDx + meanDy * meanDy);
  final double directionalCoherence = meanMagnitude <= 1e-12
      ? 0
      : (meanVectorMagnitude / meanMagnitude).clamp(0.0, 1.0).toDouble();
  return LocalResidualStatistics(
    count: matches.length,
    rms: rms,
    meanMagnitude: meanMagnitude,
    medianMagnitude: _residualPercentile(magnitudes, 0.50),
    p90Magnitude: _residualPercentile(magnitudes, 0.90),
    p95Magnitude: _residualPercentile(magnitudes, 0.95),
    maxMagnitude: magnitudes.last,
    meanDx: meanDx,
    meanDy: meanDy,
    meanVectorMagnitude: meanVectorMagnitude,
    directionalCoherence: directionalCoherence,
  );
}

/// Local correction is optional refinement. Keep it only when it improves RMS
/// *without worsening the residual tail*. This is threshold-free: the global
/// transform is the baseline, so a local warp is never allowed to trade a few
/// severely misaligned stars for a lower average. Directional coherence is
/// still reported, but is not used here because a least-squares global rigid
/// fit naturally drives its mean residual vector very close to zero; requiring
/// a local field to beat that value would reject almost every useful local fit.
bool localResidualCorrectionIsDistributionSafe({
  required LocalResidualStatistics globalStatistics,
  required LocalResidualStatistics correctedStatistics,
  double epsilon = 1e-9,
}) {
  return correctedStatistics.rms <= globalStatistics.rms + epsilon &&
      correctedStatistics.p95Magnitude <=
          globalStatistics.p95Magnitude + epsilon &&
      correctedStatistics.maxMagnitude <=
          globalStatistics.maxMagnitude + epsilon;
}

List<LocalResidualMatch> buildLocalResidualMatches({
  required List<StarMatch> matches,
  required List<DetectedStar> referenceStars,
  required List<DetectedStar> targetStars,
  required AffineSamplingTransform globalTransform,
}) {
  return <LocalResidualMatch>[
    for (final StarMatch match in matches)
      _residualMatchFor(match, referenceStars, targetStars, globalTransform),
  ];
}

LocalResidualMatch _residualMatchFor(
  StarMatch match,
  List<DetectedStar> referenceStars,
  List<DetectedStar> targetStars,
  AffineSamplingTransform globalTransform,
) {
  final DetectedStar reference = referenceStars[match.referenceIndex];
  final DetectedStar target = targetStars[match.targetIndex];
  // Work351: evaluate through the transform so projective (homography)
  // registrations produce correct residuals. For affine transforms
  // sourceX/sourceY evaluate the identical expression as before.
  final double predictedTargetX =
      globalTransform.sourceX(reference.x, reference.y);
  final double predictedTargetY =
      globalTransform.sourceY(reference.x, reference.y);
  return LocalResidualMatch(
    referenceX: reference.x,
    referenceY: reference.y,
    residualX: target.x - predictedTargetX,
    residualY: target.y - predictedTargetY,
  );
}
