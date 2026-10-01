import 'star_detector.dart';

/// Comparison between the same registered stars in the selected reference
/// frame and the final stack. The measurement uses the detector's local
/// Gaussian-marginal FWHM estimate rather than a wide second-moment window, so
/// lower background noise in the stack does not automatically inflate the
/// width simply by exposing more faint wings.
final class StarPsfQualityComparison {
  const StarPsfQualityComparison({
    required this.referenceStarCount,
    required this.finalStarCount,
    required this.referenceMeasuredStarCount,
    required this.finalMeasuredStarCount,
    required this.positionMatchedCount,
    required this.measuredPairCount,
    this.medianFwhmRatio,
    this.p90FwhmRatio,
    this.medianRoundnessDelta,
  });

  final int referenceStarCount;
  final int finalStarCount;
  final int referenceMeasuredStarCount;
  final int finalMeasuredStarCount;
  final int positionMatchedCount;
  final int measuredPairCount;
  final double? medianFwhmRatio;
  final double? p90FwhmRatio;
  final double? medianRoundnessDelta;
}

final class StarPsfQualityGateResult {
  const StarPsfQualityGateResult({
    required this.comparison,
    required this.hasEnoughMeasurements,
    required this.passed,
    required this.reasons,
  });

  final StarPsfQualityComparison comparison;
  final bool hasEnoughMeasurements;
  final bool passed;
  final List<String> reasons;
}

class MilkyWayStackQualityFailed implements Exception {
  const MilkyWayStackQualityFailed(this.result);

  final StarPsfQualityGateResult result;

  @override
  String toString() =>
      'MilkyWayStackQualityFailed: ${result.reasons.join('; ')}';
}

double _percentile(List<double> sorted, double fraction) {
  if (sorted.isEmpty) {
    throw ArgumentError('percentile requires at least one value.');
  }
  if (sorted.length == 1) return sorted.first;
  final double position = fraction * (sorted.length - 1);
  final int lower = position.floor();
  final int upper = position.ceil();
  if (lower == upper) return sorted[lower];
  final double t = position - lower;
  return sorted[lower] * (1 - t) + sorted[upper] * t;
}

/// Matches final-stack detections back to reference detections by position.
/// The stack is rendered on the reference coordinate grid, so a true star
/// should remain within [matchRadiusPx]. Each final star can be used once.
StarPsfQualityComparison compareRegisteredStarPsf({
  required List<DetectedStar> referenceStars,
  required List<DetectedStar> finalStars,
  double matchRadiusPx = 2.0,
}) {
  if (!matchRadiusPx.isFinite || matchRadiusPx <= 0) {
    throw ArgumentError.value(matchRadiusPx, 'matchRadiusPx');
  }
  final Set<int> usedFinalIndices = <int>{};
  final List<double> fwhmRatios = <double>[];
  final List<double> roundnessDeltas = <double>[];
  int positionMatchedCount = 0;
  final double maxDistanceSquared = matchRadiusPx * matchRadiusPx;

  // Bright reference detections are already sorted first. Greedy unique
  // nearest-neighbour matching is deterministic and avoids one bright final
  // detection being counted multiple times.
  for (final DetectedStar reference in referenceStars) {
    int bestIndex = -1;
    double bestDistanceSquared = maxDistanceSquared;
    for (int i = 0; i < finalStars.length; i++) {
      if (usedFinalIndices.contains(i)) continue;
      final DetectedStar candidate = finalStars[i];
      final double dx = candidate.x - reference.x;
      final double dy = candidate.y - reference.y;
      final double distanceSquared = dx * dx + dy * dy;
      if (distanceSquared <= bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) continue;
    usedFinalIndices.add(bestIndex);
    positionMatchedCount++;
    final DetectedStar finalStar = finalStars[bestIndex];
    roundnessDeltas.add(finalStar.roundness - reference.roundness);

    final double? referenceFwhm = reference.psfFwhmPx;
    final double? finalFwhm = finalStar.psfFwhmPx;
    if (referenceFwhm == null ||
        finalFwhm == null ||
        !referenceFwhm.isFinite ||
        !finalFwhm.isFinite ||
        referenceFwhm <= 0 ||
        finalFwhm <= 0) {
      continue;
    }
    fwhmRatios.add(finalFwhm / referenceFwhm);
  }

  fwhmRatios.sort();
  roundnessDeltas.sort();
  return StarPsfQualityComparison(
    referenceStarCount: referenceStars.length,
    finalStarCount: finalStars.length,
    referenceMeasuredStarCount: referenceStars
        .where((DetectedStar star) =>
            star.psfFwhmPx != null &&
            star.psfFwhmPx!.isFinite &&
            star.psfFwhmPx! > 0)
        .length,
    finalMeasuredStarCount: finalStars
        .where((DetectedStar star) =>
            star.psfFwhmPx != null &&
            star.psfFwhmPx!.isFinite &&
            star.psfFwhmPx! > 0)
        .length,
    positionMatchedCount: positionMatchedCount,
    measuredPairCount: fwhmRatios.length,
    medianFwhmRatio: fwhmRatios.isEmpty ? null : _percentile(fwhmRatios, 0.50),
    p90FwhmRatio: fwhmRatios.isEmpty ? null : _percentile(fwhmRatios, 0.90),
    medianRoundnessDelta:
        roundnessDeltas.isEmpty ? null : _percentile(roundnessDeltas, 0.50),
  );
}

/// Conservative final-image fail gate. The bicubic resampler's own synthetic
/// worst-case contract documents ~3% FWHM broadening for a Gaussian point
/// source. WORK347 allows materially more than that to absorb real-scene
/// measurement scatter, but refuses a stack with systematic star broadening
/// or elongation large enough to match the reported line/ellipse failure.
///
/// Thresholds are explicit and caller-configurable. They are safety limits,
/// not a claim that 12% broadening is desirable; real-RAW A/B data can tighten
/// them later without changing the measurement method.
StarPsfQualityGateResult evaluateStarPsfQualityGate({
  required StarPsfQualityComparison comparison,
  int minimumMeasuredPairs = 8,
  double maximumMedianFwhmRatio = 1.12,
  double maximumP90FwhmRatio = 1.30,
  double maximumMedianRoundnessIncrease = 0.12,
}) {
  if (minimumMeasuredPairs < 1 ||
      !maximumMedianFwhmRatio.isFinite ||
      maximumMedianFwhmRatio <= 1 ||
      !maximumP90FwhmRatio.isFinite ||
      maximumP90FwhmRatio <= 1 ||
      !maximumMedianRoundnessIncrease.isFinite ||
      maximumMedianRoundnessIncrease < 0) {
    throw ArgumentError('Invalid star PSF quality-gate parameters.');
  }
  if (comparison.measuredPairCount < minimumMeasuredPairs) {
    final bool referenceHadEnough =
        comparison.referenceMeasuredStarCount >= minimumMeasuredPairs;
    return StarPsfQualityGateResult(
      comparison: comparison,
      hasEnoughMeasurements: false,
      // If the reference itself offered enough measurable stars but the final
      // stack cannot preserve enough of them for the same PSF measurement,
      // fail closed. A quality gate that silently disables itself only after
      // stacking would allow exactly the catastrophic blur it exists to catch.
      passed: !referenceHadEnough,
      reasons: <String>[
        'insufficient PSF pairs: ${comparison.measuredPairCount} '
            '< $minimumMeasuredPairs '
            '(referenceMeasured=${comparison.referenceMeasuredStarCount}, '
            'finalMeasured=${comparison.finalMeasuredStarCount})',
      ],
    );
  }

  final List<String> failures = <String>[];
  final double? medianValue = comparison.medianFwhmRatio;
  final double? p90Value = comparison.p90FwhmRatio;
  if (medianValue == null ||
      !medianValue.isFinite ||
      medianValue <= 0 ||
      p90Value == null ||
      !p90Value.isFinite ||
      p90Value <= 0 ||
      comparison.medianRoundnessDelta == null ||
      !comparison.medianRoundnessDelta!.isFinite) {
    return StarPsfQualityGateResult(
      comparison: comparison,
      hasEnoughMeasurements: true,
      passed: false,
      reasons: const ['invalid final PSF measurements'],
    );
  }
  final double median = medianValue;
  final double p90 = p90Value;
  final double? roundnessDelta = comparison.medianRoundnessDelta;
  if (median > maximumMedianFwhmRatio) {
    failures.add(
      'median FWHM ratio ${median.toStringAsFixed(4)} > '
      '${maximumMedianFwhmRatio.toStringAsFixed(4)}',
    );
  }
  // A tail-only excursion should not fail a good stack because one blended or
  // variable source can be pathological. Require at least a small systematic
  // shift in the median before p90 alone becomes blocking.
  if (p90 > maximumP90FwhmRatio && median > 1.05) {
    failures.add(
      'p90 FWHM ratio ${p90.toStringAsFixed(4)} > '
      '${maximumP90FwhmRatio.toStringAsFixed(4)} with median > 1.05',
    );
  }
  if (roundnessDelta != null &&
      roundnessDelta > maximumMedianRoundnessIncrease) {
    failures.add(
      'median roundness increase ${roundnessDelta.toStringAsFixed(4)} > '
      '${maximumMedianRoundnessIncrease.toStringAsFixed(4)}',
    );
  }

  return StarPsfQualityGateResult(
    comparison: comparison,
    hasEnoughMeasurements: true,
    passed: failures.isEmpty,
    reasons: failures.isEmpty ? const <String>[] : failures,
  );
}
