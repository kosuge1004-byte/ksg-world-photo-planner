/// Reference per-frame registration-quality weighting for Mobile
/// Stack's Milky Way stacking stage.
///
/// `milky_way_pipeline.dart`'s `registerAndCombineDecodedFrames` (Work54)
/// combines every successfully-registered frame with a uniform weight of
/// 1, regardless of how well each one actually registered — a frame that
/// barely passed `estimateSimilarityTransform`'s acceptance gate (a high
/// but still-accepted RMS residual, meaning its star positions only
/// loosely agree with the fitted rigid transform) is trusted exactly as
/// much as a frame that registered almost perfectly. This module weighs
/// frames by their own registration quality instead, so a shakier
/// registration contributes proportionally less to the final stack
/// rather than being trusted equally with a solid one — a direct image-
/// quality improvement (see WORK56_PROGRESS.md).

export class InvalidRegistrationWeightInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRegistrationWeightInput';
  }
}

/// Converts a registration fit's RMS residual (pixels) into a stacking
/// weight in `(0, 1]`.
///
/// `weight = 1 / (1 + (rmsResidual / residualHalfWeightRadius)^2)`,
/// clamped below by `minimumWeight`.
///
/// - At `rmsResidual = 0` (a perfect fit — always true for the reference
///   frame itself, which is registered to itself by construction, not
///   fitted): `weight = 1`.
/// - At `rmsResidual = residualHalfWeightRadius` (default 1.5, matching
///   `estimateSimilarityTransform`'s own default `maxAcceptableRmsResidual`
///   — i.e. a frame at the edge of what that function accepts at all):
///   `weight = 0.5`.
/// - As `rmsResidual` grows further: weight continues falling off
///   smoothly (an inverse-square falloff, the same functional form as
///   inverse-variance weighting, the statistically optimal choice for
///   combining independent noisy measurements when the residual is
///   treated as a proxy for that measurement's uncertainty), never
///   reaching exactly 0.
/// - `minimumWeight` (default 0.05): a frame that was accepted at all by
///   the registration gate still contributed *some* real information;
///   a hard floor prevents an admittedly-marginal-but-accepted frame
///   from being weighted into practical irrelevance, which would make
///   the earlier accept/reject decision and this weighting redundant
///   with each other rather than complementary.
///
/// Throws {@link InvalidRegistrationWeightInput} if `rmsResidual` is
/// negative or non-finite, or if `residualHalfWeightRadius` is not
/// positive.
export function registrationQualityWeight(rmsResidual, {
  residualHalfWeightRadius = 1.5,
  minimumWeight = 0.05,
} = {}) {
  if (!Number.isFinite(rmsResidual) || rmsResidual < 0) {
    throw new InvalidRegistrationWeightInput(
      'rmsResidual must be a non-negative finite number.',
    );
  }
  if (!Number.isFinite(residualHalfWeightRadius)
      || !(residualHalfWeightRadius > 0)) {
    throw new InvalidRegistrationWeightInput(
      'residualHalfWeightRadius must be finite and positive.',
    );
  }
  if (!(minimumWeight >= 0) || minimumWeight > 1) {
    throw new InvalidRegistrationWeightInput(
      'minimumWeight must be in [0, 1].',
    );
  }
  const ratio = rmsResidual / residualHalfWeightRadius;
  const weight = 1 / (1 + ratio * ratio);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new InvalidRegistrationWeightInput(
      'Registration weighting produced an invalid result.',
    );
  }
  return Math.max(minimumWeight, weight);
}
