import 'dart:math' as math;

import 'local_residual_correction.dart';
import 'star_detector.dart';
import 'star_transform_estimator.dart';

/// Spatial support of the matched reference stars used by one registration.
/// This is diagnostic-only in WORK348; no geometry is rejected solely because
/// a sparse star field happens to occupy only part of the image.
final class RegistrationSpatialCoverage {
  const RegistrationSpatialCoverage({
    required this.spanXFraction,
    required this.spanYFraction,
    required this.occupiedQuadrants,
  });

  final double spanXFraction;
  final double spanYFraction;
  final int occupiedQuadrants;
}

RegistrationSpatialCoverage summarizeRegistrationSpatialCoverage({
  required List<StarMatch> matches,
  required List<DetectedStar> referenceStars,
  required int imageWidth,
  required int imageHeight,
}) {
  if (imageWidth <= 0 || imageHeight <= 0) {
    throw ArgumentError('Image dimensions must be positive.');
  }
  if (matches.isEmpty) {
    return const RegistrationSpatialCoverage(
      spanXFraction: 0,
      spanYFraction: 0,
      occupiedQuadrants: 0,
    );
  }
  double minX = double.infinity;
  double maxX = double.negativeInfinity;
  double minY = double.infinity;
  double maxY = double.negativeInfinity;
  final Set<int> quadrants = <int>{};
  final double centerX = (imageWidth - 1) * 0.5;
  final double centerY = (imageHeight - 1) * 0.5;
  for (final StarMatch match in matches) {
    if (match.referenceIndex < 0 ||
        match.referenceIndex >= referenceStars.length) {
      throw RangeError.index(
        match.referenceIndex,
        referenceStars,
        'match.referenceIndex',
      );
    }
    final DetectedStar star = referenceStars[match.referenceIndex];
    if (star.x < minX) minX = star.x;
    if (star.x > maxX) maxX = star.x;
    if (star.y < minY) minY = star.y;
    if (star.y > maxY) maxY = star.y;
    final int quadrant =
        (star.y >= centerY ? 2 : 0) + (star.x >= centerX ? 1 : 0);
    quadrants.add(quadrant);
  }
  final double xDenominator = math.max(1, imageWidth - 1).toDouble();
  final double yDenominator = math.max(1, imageHeight - 1).toDouble();
  return RegistrationSpatialCoverage(
    spanXFraction: ((maxX - minX) / xDenominator).clamp(0.0, 1.0).toDouble(),
    spanYFraction: ((maxY - minY) / yDenominator).clamp(0.0, 1.0).toDouble(),
    occupiedQuadrants: quadrants.length,
  );
}

final class RegistrationHardQualityGateResult {
  const RegistrationHardQualityGateResult({
    required this.passed,
    required this.reasons,
    required this.rmsLimitPx,
    required this.p95LimitPx,
    required this.maxLimitPx,
    required this.referenceMedianFwhmPx,
    required this.usedPsfDerivedRmsLimit,
  });

  final bool passed;
  final List<String> reasons;
  final double rmsLimitPx;
  final double p95LimitPx;
  final double maxLimitPx;
  final double? referenceMedianFwhmPx;
  final bool usedPsfDerivedRmsLimit;
}

double _percentile(List<double> sorted, double fraction) {
  if (sorted.isEmpty) throw ArgumentError('percentile requires values.');
  if (sorted.length == 1) return sorted.first;
  final double position = fraction * (sorted.length - 1);
  final int lower = position.floor();
  final int upper = position.ceil();
  if (lower == upper) return sorted[lower];
  final double t = position - lower;
  return sorted[lower] * (1 - t) + sorted[upper] * t;
}

/// Converts the final-stack FWHM broadening budget into the maximum 2-D RMS
/// registration jitter that, under an isotropic Gaussian approximation, would
/// consume that budget by itself.
///
/// If the reference PSF has sigma `s`, independent per-axis registration jitter
/// `j` broadens it to `sqrt(s*s + j*j)`. A 2-D radial RMS residual is
/// `sqrt(2)*j`, while `FWHM = 2.354820045*s`. Solving for radial RMS gives:
///
///   rms / FWHM = sqrt(2) / 2.354820045 * sqrt(ratio^2 - 1)
///
/// WORK348 deliberately derives the frame gate from the already-existing final
/// PSF safety budget instead of introducing an unrelated pixel threshold.
double registrationRmsFractionForFwhmRatio(double maximumFwhmRatio) {
  if (!maximumFwhmRatio.isFinite || maximumFwhmRatio <= 1) {
    throw ArgumentError.value(maximumFwhmRatio, 'maximumFwhmRatio');
  }
  return math.sqrt(2) /
      2.354820045 *
      math.sqrt(maximumFwhmRatio * maximumFwhmRatio - 1);
}

/// Quality-first hard gate applied before a registered frame reaches the
/// combiner.
///
/// Three independent limits are used:
/// - RMS: when enough reference PSF widths are measurable, derive the limit
///   from the final PSF broadening budget (default 1.12). Otherwise fall back
///   to the transform estimator's refined matching radius.
/// - p95: must remain within the refined matching radius.
/// - max: must remain within the original matching radius.
///
/// This means a bad frame is excluded instead of merely being assigned the
/// historical minimum non-zero stacking weight.
RegistrationHardQualityGateResult evaluateRegistrationHardQualityGate({
  required LocalResidualStatistics residuals,
  required List<DetectedStar> referenceStars,
  required double transformToleranceRadius,
  double maximumFinalMedianFwhmRatio = 1.12,
  int minimumReferencePsfMeasurements = 5,
}) {
  if (!transformToleranceRadius.isFinite || transformToleranceRadius <= 0) {
    throw ArgumentError.value(
      transformToleranceRadius,
      'transformToleranceRadius',
    );
  }
  if (minimumReferencePsfMeasurements < 1) {
    throw ArgumentError.value(
      minimumReferencePsfMeasurements,
      'minimumReferencePsfMeasurements',
    );
  }
  // Validate the budget even when PSF support is insufficient.
  registrationRmsFractionForFwhmRatio(maximumFinalMedianFwhmRatio);
  final List<double> widths = <double>[
    for (final DetectedStar star in referenceStars)
      if (star.psfFwhmPx != null &&
          star.psfFwhmPx!.isFinite &&
          star.psfFwhmPx! > 0)
        star.psfFwhmPx!,
  ]..sort();
  final bool hasPsfSupport = widths.length >= minimumReferencePsfMeasurements;
  final double? medianFwhm = hasPsfSupport ? _percentile(widths, 0.50) : null;
  final double refinedRadius = math.max(0.75, transformToleranceRadius / 2);
  final double psfRmsLimit = medianFwhm == null
      ? refinedRadius
      : medianFwhm *
          registrationRmsFractionForFwhmRatio(maximumFinalMedianFwhmRatio);
  final double rmsLimit = math.min(refinedRadius, psfRmsLimit);
  final double p95Limit = refinedRadius;
  final double maxLimit = transformToleranceRadius;

  final List<String> failures = <String>[];
  if (residuals.count < 1 ||
      !residuals.rms.isFinite ||
      residuals.rms < 0 ||
      !residuals.p95Magnitude.isFinite ||
      residuals.p95Magnitude < 0 ||
      !residuals.maxMagnitude.isFinite ||
      residuals.maxMagnitude < 0) {
    failures.add('missing or non-finite registration residuals');
  }
  if (residuals.rms > rmsLimit) {
    failures.add(
      'RMS ${residuals.rms.toStringAsFixed(4)}px > '
      '${rmsLimit.toStringAsFixed(4)}px',
    );
  }
  if (residuals.p95Magnitude > p95Limit) {
    failures.add(
      'p95 ${residuals.p95Magnitude.toStringAsFixed(4)}px > '
      '${p95Limit.toStringAsFixed(4)}px',
    );
  }
  if (residuals.maxMagnitude > maxLimit) {
    failures.add(
      'max ${residuals.maxMagnitude.toStringAsFixed(4)}px > '
      '${maxLimit.toStringAsFixed(4)}px',
    );
  }

  return RegistrationHardQualityGateResult(
    passed: failures.isEmpty,
    reasons: failures,
    rmsLimitPx: rmsLimit,
    p95LimitPx: p95Limit,
    maxLimitPx: maxLimit,
    referenceMedianFwhmPx: medianFwhm,
    usedPsfDerivedRmsLimit: hasPsfSupport,
  );
}
/// Result of [evaluateRegistrationCoverageGate].
final class RegistrationCoverageGateResult {
  const RegistrationCoverageGateResult({
    required this.passed,
    required this.reasons,
    required this.supportedQuadrants,
    required this.matchedQuadrants,
    required this.spanXRatio,
    required this.spanYRatio,
  });

  final bool passed;
  final List<String> reasons;
  final List<int> supportedQuadrants;
  final List<int> matchedQuadrants;
  final double spanXRatio;
  final double spanYRatio;
}

/// Whole-field coverage gate (Work351, guided registration only; the legacy
/// rigid path never calls it, so its behaviour is unchanged).
///
/// Dart port of `evaluateRegistrationCoverageGate` in
/// `tool/raw_samples/guided_field_registration_reference.mjs`.
///
/// The matched reference stars must cover the part of the field in which the
/// reference frame itself has stars. The requirement is relative to the
/// reference on purpose, so that a starless landscape foreground does not
/// reject every frame:
/// - at least [minimumMatches] strict matches;
/// - matched span / reference-star span >= [minimumSpanRatio] per axis;
/// - every quadrant holding >= [minimumQuadrantShare] of the reference stars
///   contains at least one match.
///
/// A frame that fails is resampled correctly only near its matches and would
/// smear the rest of the field, so it is excluded rather than down-weighted.
RegistrationCoverageGateResult evaluateRegistrationCoverageGate({
  required List<StarMatch> matches,
  required List<DetectedStar> referenceStars,
  required int imageWidth,
  required int imageHeight,
  int minimumMatches = 12,
  double minimumSpanRatio = 0.7,
  double minimumQuadrantShare = 0.08,
}) {
  if (imageWidth <= 0 ||
      imageHeight <= 0 ||
      minimumMatches < 1 ||
      !(minimumSpanRatio > 0 && minimumSpanRatio <= 1) ||
      !(minimumQuadrantShare > 0 && minimumQuadrantShare < 1)) {
    throw ArgumentError('Coverage gate parameters are invalid.');
  }
  final double centerX = (imageWidth - 1) * 0.5;
  final double centerY = (imageHeight - 1) * 0.5;
  int quadrantOf(DetectedStar s) =>
      (s.y >= centerY ? 2 : 0) + (s.x >= centerX ? 1 : 0);
  ({double x, double y}) spanOf(Iterable<DetectedStar> stars) {
    double minX = double.infinity;
    double maxX = double.negativeInfinity;
    double minY = double.infinity;
    double maxY = double.negativeInfinity;
    bool any = false;
    for (final DetectedStar s in stars) {
      any = true;
      minX = math.min(minX, s.x);
      maxX = math.max(maxX, s.x);
      minY = math.min(minY, s.y);
      maxY = math.max(maxY, s.y);
    }
    return any ? (x: maxX - minX, y: maxY - minY) : (x: 0.0, y: 0.0);
  }

  final List<int> counts = List<int>.filled(4, 0);
  for (final DetectedStar s in referenceStars) {
    counts[quadrantOf(s)]++;
  }
  final List<int> supported = <int>[
    for (int q = 0; q < 4; q++)
      if (referenceStars.isNotEmpty &&
          counts[q] >= minimumQuadrantShare * referenceStars.length)
        q,
  ];
  final Set<int> matched = <int>{};
  final List<DetectedStar> matchedStars = <DetectedStar>[];
  for (final StarMatch match in matches) {
    if (match.referenceIndex < 0 ||
        match.referenceIndex >= referenceStars.length) {
      throw RangeError.index(
        match.referenceIndex,
        referenceStars,
        'match.referenceIndex',
      );
    }
    final DetectedStar s = referenceStars[match.referenceIndex];
    matched.add(quadrantOf(s));
    matchedStars.add(s);
  }
  final ({double x, double y}) referenceSpan = spanOf(referenceStars);
  final ({double x, double y}) matchedSpan = spanOf(matchedStars);
  final double spanXRatio =
      referenceSpan.x > 0 ? matchedSpan.x / referenceSpan.x : 1;
  final double spanYRatio =
      referenceSpan.y > 0 ? matchedSpan.y / referenceSpan.y : 1;
  final List<String> reasons = <String>[];
  if (matches.length < minimumMatches) {
    reasons.add('matches ${matches.length} < $minimumMatches');
  }
  if (spanXRatio < minimumSpanRatio) {
    reasons.add(
      'span X ratio ${spanXRatio.toStringAsFixed(3)} < $minimumSpanRatio',
    );
  }
  if (spanYRatio < minimumSpanRatio) {
    reasons.add(
      'span Y ratio ${spanYRatio.toStringAsFixed(3)} < $minimumSpanRatio',
    );
  }
  final List<int> missing = <int>[
    for (final int q in supported)
      if (!matched.contains(q)) q,
  ];
  if (missing.isNotEmpty) {
    reasons.add('no matches in supported quadrant(s) ${missing.join(",")}');
  }
  return RegistrationCoverageGateResult(
    passed: reasons.isEmpty,
    reasons: List<String>.unmodifiable(reasons),
    supportedQuadrants: List<int>.unmodifiable(supported),
    matchedQuadrants: List<int>.unmodifiable(matched.toList()..sort()),
    spanXRatio: spanXRatio,
    spanYRatio: spanYRatio,
  );
}
