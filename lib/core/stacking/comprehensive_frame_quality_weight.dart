/// Dart port of `tool/raw_samples/comprehensive_frame_quality_weight_
/// reference.mjs`.
///
/// Addresses a real gap this project's frame weighting had:
/// `registration_quality_weight.dart`'s own `registrationQualityWeight`
/// (Work56) weighs a frame only by its own registration RMS residual,
/// ignoring everything about the frame's own *image* quality (seeing,
/// tracking, transparency) that the frame's own detected stars already
/// carry — `star_detector.dart`'s own `DetectedStar` already reports
/// `roundness` (an elongation/eccentricity proxy) and a detected star
/// *count*, neither of which this project's stacking weight has ever
/// used.
///
/// See the Node reference's own doc comment for the full design
/// rationale. In short: [starShapeQualityWeight] and
/// [starCountQualityWeight] follow the same inverse-square falloff form
/// `registrationQualityWeight` already established, and
/// [comprehensiveFrameQualityWeight] combines all three factors by
/// multiplication — backward compatible with a frame that has no
/// detected-star quality information (reduces to the registration
/// weight alone, unchanged from this project's pre-existing behavior).
///
/// This file has not been executed against the Dart SDK. It is a
/// careful line-by-line translation of the Node reference, which has
/// full test coverage. Run `test/comprehensive_frame_quality_weight_
/// test.dart` before relying on this in production.

library;

class InvalidFrameQualityWeightInput extends ArgumentError {
  InvalidFrameQualityWeightInput(String super.message);
}

double _median(List<double> values) {
  final List<double> sorted = List<double>.of(values)..sort();
  final int middle = sorted.length >> 1;
  return sorted.length.isOdd
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
}

double _inverseSquareFalloff(
  double deviation,
  double halfWeightPoint,
  double minimumWeight,
) {
  final double ratio = deviation / halfWeightPoint;
  final double weight = 1 / (1 + ratio * ratio);
  return weight < minimumWeight ? minimumWeight : weight;
}

/// Converts a frame's detected stars' own [roundnessValues] (each in
/// `[0, 1)`, matching `DetectedStar.roundness`'s own documented range)
/// into a weight in `(0, 1]`, via the median roundness's inverse-square
/// falloff from `0` (a perfectly round source).
///
/// Returns `1` (no discount) if [roundnessValues] is empty.
///
/// Throws [InvalidFrameQualityWeightInput] if [roundnessHalfWeight] is
/// not positive, [minimumWeight] is outside `[0, 1]`, or any entry of
/// [roundnessValues] is negative, non-finite, or `>= 1`.
double starShapeQualityWeight(
  List<double> roundnessValues, {
  double roundnessHalfWeight = 0.3,
  double minimumWeight = 0.05,
}) {
  if (!roundnessHalfWeight.isFinite || !(roundnessHalfWeight > 0)) {
    throw InvalidFrameQualityWeightInput(
      'roundnessHalfWeight must be finite and positive.',
    );
  }
  if (!(minimumWeight >= 0) || minimumWeight > 1) {
    throw InvalidFrameQualityWeightInput('minimumWeight must be in [0, 1].');
  }
  for (final double value in roundnessValues) {
    if (!value.isFinite || value < 0 || value >= 1) {
      throw InvalidFrameQualityWeightInput(
        'Every roundness value must be finite and in [0, 1).',
      );
    }
  }
  if (roundnessValues.isEmpty) return 1;
  final double medianRoundness = _median(roundnessValues);
  return _inverseSquareFalloff(
    medianRoundness,
    roundnessHalfWeight,
    minimumWeight,
  );
}

/// Converts a frame's own detected star count ([detectedStarCount])
/// relative to the reference frame's own count ([referenceStarCount])
/// into a weight in `(0, 1]`. A frame that detected as many or more
/// stars than the reference gets `1`; fewer gets progressively
/// discounted via the same inverse-square falloff form.
///
/// Returns `1` if [referenceStarCount] is `0`.
///
/// Throws [InvalidFrameQualityWeightInput] if [detectedStarCount] or
/// [referenceStarCount] is negative, if
/// [countShortfallHalfWeightFraction] is not positive, or
/// [minimumWeight] is outside `[0, 1]`.
double starCountQualityWeight(
  int detectedStarCount,
  int referenceStarCount, {
  double countShortfallHalfWeightFraction = 0.5,
  double minimumWeight = 0.05,
}) {
  if (detectedStarCount < 0) {
    throw InvalidFrameQualityWeightInput(
      'detectedStarCount must be a non-negative integer.',
    );
  }
  if (referenceStarCount < 0) {
    throw InvalidFrameQualityWeightInput(
      'referenceStarCount must be a non-negative integer.',
    );
  }
  if (!countShortfallHalfWeightFraction.isFinite ||
      !(countShortfallHalfWeightFraction > 0)) {
    throw InvalidFrameQualityWeightInput(
      'countShortfallHalfWeightFraction must be finite and positive.',
    );
  }
  if (!(minimumWeight >= 0) || minimumWeight > 1) {
    throw InvalidFrameQualityWeightInput('minimumWeight must be in [0, 1].');
  }
  if (referenceStarCount == 0) return 1;
  final int shortfall = referenceStarCount - detectedStarCount;
  if (shortfall <= 0) return 1;
  final double halfWeightPoint =
      referenceStarCount * countShortfallHalfWeightFraction;
  return _inverseSquareFalloff(
    shortfall.toDouble(),
    halfWeightPoint,
    minimumWeight,
  );
}

/// Combines a frame's own registration-residual-derived weight
/// ([registrationWeight], typically `registrationQualityWeight`'s own
/// return value) with [starShapeQualityWeight] and
/// [starCountQualityWeight] by straightforward multiplication.
///
/// Backward compatible: a frame with no detected-star quality
/// information (pass `roundnessValues: []`,
/// `detectedStarCount: referenceStarCount`) reduces to exactly
/// [registrationWeight] alone.
///
/// Throws [InvalidFrameQualityWeightInput] if [registrationWeight] is
/// outside `[0, 1]`, or (via the two component functions) for any of
/// their own respective invalid inputs.
double comprehensiveFrameQualityWeight({
  required double registrationWeight,
  required List<double> roundnessValues,
  required int detectedStarCount,
  required int referenceStarCount,
  double roundnessHalfWeight = 0.3,
  double countShortfallHalfWeightFraction = 0.5,
  double minimumWeight = 0.05,
}) {
  if (!(registrationWeight >= 0) || registrationWeight > 1) {
    throw InvalidFrameQualityWeightInput(
      'registrationWeight must be in [0, 1].',
    );
  }
  final double shapeWeight = starShapeQualityWeight(
    roundnessValues,
    roundnessHalfWeight: roundnessHalfWeight,
    minimumWeight: minimumWeight,
  );
  final double countWeight = starCountQualityWeight(
    detectedStarCount,
    referenceStarCount,
    countShortfallHalfWeightFraction: countShortfallHalfWeightFraction,
    minimumWeight: minimumWeight,
  );
  final double combined = registrationWeight * shapeWeight * countWeight;
  if (!combined.isFinite || combined < 0 || combined > 1) {
    throw InvalidFrameQualityWeightInput(
      'Combined frame quality weight is invalid.',
    );
  }
  return combined < minimumWeight ? minimumWeight : combined;
}

/// Scores a candidate reference frame using only image-intrinsic star quality.
///
/// This deliberately reuses [comprehensiveFrameQualityWeight] rather than
/// inventing a second reference-selection heuristic. Registration weight is
/// fixed to `1` because no frame has been registered yet. [bestObservedStarCount]
/// is the maximum detected-star count among all usable candidates.
double intrinsicReferenceFrameQualityWeight({
  required List<double> roundnessValues,
  required int detectedStarCount,
  required int bestObservedStarCount,
  double roundnessHalfWeight = 0.3,
  double countShortfallHalfWeightFraction = 0.5,
  double minimumWeight = 0.05,
}) {
  return comprehensiveFrameQualityWeight(
    registrationWeight: 1,
    roundnessValues: roundnessValues,
    detectedStarCount: detectedStarCount,
    referenceStarCount: bestObservedStarCount,
    roundnessHalfWeight: roundnessHalfWeight,
    countShortfallHalfWeightFraction: countShortfallHalfWeightFraction,
    minimumWeight: minimumWeight,
  );
}
