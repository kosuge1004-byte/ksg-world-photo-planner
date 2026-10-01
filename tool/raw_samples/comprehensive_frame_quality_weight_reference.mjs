/// Reference implementation of comprehensive, multi-factor frame
/// quality weighting — addressing a real gap this project's frame
/// weighting had: `registration_quality_weight_reference.mjs`'s own
/// `registrationQualityWeight` (Work56) weighs a frame only by its own
/// registration RMS residual, ignoring everything about the frame's own
/// *image* quality (seeing, tracking, transparency) that the frame's
/// own detected stars already carry — `star_centroid_detector_
/// reference.mjs`'s own `DetectedStar` already reports `roundness`
/// (an elongation/eccentricity proxy — 0 for a round source, approaching
/// 1 for something elongated, e.g. by tracking drift or wind-shake
/// during the exposure) and a detected star *count*, neither of which
/// this project's stacking weight has ever used.
///
/// This module adds two more weighting factors, each following the same
/// smooth, inverse-square falloff functional form
/// `registrationQualityWeight` itself already established (statistically
/// the optimal weighting for combining independent noisy measurements
/// when a residual/deviation is treated as a proxy for that
/// measurement's own uncertainty), then combines all contributing
/// factors by multiplication (each factor independently discounts the
/// combined weight, matching how independent sources of measurement
/// uncertainty combine):
///
/// - [starShapeQualityWeight]: derived from the *median* roundness
///   across a frame's own detected stars (median, not mean, so a
///   handful of poorly-shaped detections — e.g. a star caught mid-trail
///   by a brief gust, or a blended pair — do not dominate the frame's
///   own overall shape assessment the way an outlier-sensitive mean
///   would). A frame whose stars are systematically more elongated than
///   the reference frame's own (tracking drift, wind-shake, focus
///   drift) is weighted down.
/// - [starCountQualityWeight]: derived from how many stars a frame
///   detected *relative to the reference frame's own count* — fewer
///   detections in an otherwise-comparable frame is a direct, simple
///   proxy for worse transparency or seeing during that exposure (dimmer
///   stars fall below the detector's own threshold first), without
///   needing a full photometric SNR/background-sigma measurement this
///   project does not yet have a proven independent implementation of.
///
/// [comprehensiveFrameQualityWeight] combines a frame's own
/// `registrationQualityWeight` (unchanged, still computed from its own
/// RMS residual exactly as before) with these two additional factors —
/// backward compatible with a frame that has no detected-star quality
/// information available (in which case those two factors default to
/// `1`, leaving the combined weight equal to the registration weight
/// alone, exactly matching this project's pre-existing behavior).

export class InvalidFrameQualityWeightInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidFrameQualityWeightInput';
  }
}

function median(values) {
  const sorted = Float64Array.from(values).sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function inverseSquareFalloff(deviation, halfWeightPoint, minimumWeight) {
  const ratio = deviation / halfWeightPoint;
  const weight = 1 / (1 + ratio * ratio);
  return weight < minimumWeight ? minimumWeight : weight;
}

/// Converts a frame's detected stars' own [roundnessValues] (each in
/// `[0, 1)`, matching `DetectedStar.roundness`'s own documented range)
/// into a weight in `(0, 1]`, via the median roundness's inverse-square
/// falloff from `0` (a perfectly round source).
///
/// `weight = 1 / (1 + (medianRoundness / roundnessHalfWeight)^2)`,
/// clamped below by [minimumWeight] — the same functional form
/// `registrationQualityWeight` uses for RMS residual, applied here to
/// median roundness instead.
///
/// Returns `1` (no discount) if [roundnessValues] is empty — a frame
/// with no detected stars to assess shape from is not penalized here
/// (a separate, earlier gate already handles "too few stars to
/// register at all").
///
/// Throws {@link InvalidFrameQualityWeightInput} if [roundnessHalfWeight]
/// is not positive, [minimumWeight] is outside `[0, 1]`, or any entry of
/// [roundnessValues] is negative, non-finite, or `>= 1`.
export function starShapeQualityWeight(roundnessValues, {
  roundnessHalfWeight = 0.3,
  minimumWeight = 0.05,
} = {}) {
  if (!Number.isFinite(roundnessHalfWeight)
      || !(roundnessHalfWeight > 0)) {
    throw new InvalidFrameQualityWeightInput(
      'roundnessHalfWeight must be finite and positive.',
    );
  }
  if (!(minimumWeight >= 0) || minimumWeight > 1) {
    throw new InvalidFrameQualityWeightInput(
      'minimumWeight must be in [0, 1].',
    );
  }
  for (const value of roundnessValues) {
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new InvalidFrameQualityWeightInput(
        'Every roundness value must be finite and in [0, 1).',
      );
    }
  }
  if (roundnessValues.length === 0) return 1;
  const medianRoundness = median(roundnessValues);
  return inverseSquareFalloff(
    medianRoundness,
    roundnessHalfWeight,
    minimumWeight,
  );
}

/// Converts a frame's own detected star count ([detectedStarCount])
/// relative to the reference frame's own count ([referenceStarCount])
/// into a weight in `(0, 1]`. A frame that detected as many or more
/// stars than the reference gets `1` (no discount — detecting *more*
/// stars than the reference is not treated as "better", just not
/// penalized, since the reference frame's own count is the baseline a
/// caller already trusted enough to register everything else against).
/// A frame that detected fewer gets progressively discounted the larger
/// that shortfall is, via the same inverse-square falloff form (the
/// "half weight point" is expressed as a *fraction* of the reference
/// count, [countShortfallHalfWeightFraction], so it scales naturally
/// with however many stars a given field of view happens to contain).
///
/// Returns `1` if [referenceStarCount] is `0` (nothing to compare a
/// shortfall against).
///
/// Throws {@link InvalidFrameQualityWeightInput} if [detectedStarCount]
/// or [referenceStarCount] is negative, if
/// [countShortfallHalfWeightFraction] is not positive, or [minimumWeight]
/// is outside `[0, 1]`.
export function starCountQualityWeight(
  detectedStarCount,
  referenceStarCount,
  {
    countShortfallHalfWeightFraction = 0.5,
    minimumWeight = 0.05,
  } = {},
) {
  if (!Number.isInteger(detectedStarCount) || detectedStarCount < 0) {
    throw new InvalidFrameQualityWeightInput(
      'detectedStarCount must be a non-negative integer.',
    );
  }
  if (!Number.isInteger(referenceStarCount) || referenceStarCount < 0) {
    throw new InvalidFrameQualityWeightInput(
      'referenceStarCount must be a non-negative integer.',
    );
  }
  if (!Number.isFinite(countShortfallHalfWeightFraction)
      || !(countShortfallHalfWeightFraction > 0)) {
    throw new InvalidFrameQualityWeightInput(
      'countShortfallHalfWeightFraction must be finite and positive.',
    );
  }
  if (!(minimumWeight >= 0) || minimumWeight > 1) {
    throw new InvalidFrameQualityWeightInput(
      'minimumWeight must be in [0, 1].',
    );
  }
  if (referenceStarCount === 0) return 1;
  const shortfall = referenceStarCount - detectedStarCount;
  if (shortfall <= 0) return 1;
  const halfWeightPoint = referenceStarCount
    * countShortfallHalfWeightFraction;
  return inverseSquareFalloff(shortfall, halfWeightPoint, minimumWeight);
}

/// Combines a frame's own registration-residual-derived weight
/// ([registrationWeight], typically `registrationQualityWeight`'s own
/// return value — this function does not recompute it) with
/// [starShapeQualityWeight] and [starCountQualityWeight] (each computed
/// from the same [roundnessValues]/[detectedStarCount]/
/// [referenceStarCount] this function itself forwards to them) by
/// straightforward multiplication.
///
/// Backward compatible: a frame with no detected-star quality
/// information (pass `roundnessValues: []`, `detectedStarCount:
/// referenceStarCount`) reduces to exactly [registrationWeight] alone,
/// unchanged from this project's pre-existing weighting behavior.
///
/// Throws {@link InvalidFrameQualityWeightInput} if [registrationWeight]
/// is outside `[0, 1]`, or (via the two component functions) for any of
/// their own respective invalid inputs.
export function comprehensiveFrameQualityWeight({
  registrationWeight,
  roundnessValues,
  detectedStarCount,
  referenceStarCount,
  roundnessHalfWeight = 0.3,
  countShortfallHalfWeightFraction = 0.5,
  minimumWeight = 0.05,
}) {
  if (!(registrationWeight >= 0) || registrationWeight > 1) {
    throw new InvalidFrameQualityWeightInput(
      'registrationWeight must be in [0, 1].',
    );
  }
  const shapeWeight = starShapeQualityWeight(roundnessValues, {
    roundnessHalfWeight,
    minimumWeight,
  });
  const countWeight = starCountQualityWeight(
    detectedStarCount,
    referenceStarCount,
    { countShortfallHalfWeightFraction, minimumWeight },
  );
  const combined = registrationWeight * shapeWeight * countWeight;
  if (!Number.isFinite(combined) || combined < 0 || combined > 1) {
    throw new InvalidFrameQualityWeightInput(
      'Combined frame quality weight is invalid.',
    );
  }
  return combined < minimumWeight ? minimumWeight : combined;
}


export function intrinsicReferenceFrameQualityWeight({
  roundnessValues,
  detectedStarCount,
  bestObservedStarCount,
  roundnessHalfWeight = 0.3,
  countShortfallHalfWeightFraction = 0.5,
  minimumWeight = 0.05,
}) {
  return comprehensiveFrameQualityWeight({
    registrationWeight: 1,
    roundnessValues,
    detectedStarCount,
    referenceStarCount: bestObservedStarCount,
    roundnessHalfWeight,
    countShortfallHalfWeightFraction,
    minimumWeight,
  });
}
