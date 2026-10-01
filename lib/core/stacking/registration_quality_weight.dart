/// Dart port of `tool/raw_samples/registration_quality_weight_
/// reference.mjs`.
///
/// `milky_way_pipeline.dart`'s `registerAndCombineDecodedFrames` (Work54)
/// combined every successfully-registered frame with a uniform weight of
/// 1, regardless of how well each one actually registered. This module
/// weighs frames by their own registration quality instead, so a shakier
/// registration contributes proportionally less to the final stack
/// rather than being trusted equally with a solid one — see
/// WORK56_PROGRESS.md.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it); it is a careful line-by-line
/// translation of the Node reference, which has full test coverage. Run
/// `test/registration_quality_weight_test.dart` (mirroring the Node
/// fixtures) before relying on this in production.

library;

class InvalidRegistrationWeightInput extends ArgumentError {
  InvalidRegistrationWeightInput(super.message);
}

/// Converts a registration fit's RMS residual (pixels) into a stacking
/// weight in `(0, 1]`.
///
/// `weight = 1 / (1 + (rmsResidual / residualHalfWeightRadius)^2)`,
/// clamped below by [minimumWeight].
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
/// - [minimumWeight] (default 0.05): a frame that was accepted at all by
///   the registration gate still contributed *some* real information; a
///   hard floor prevents an admittedly-marginal-but-accepted frame from
///   being weighted into practical irrelevance, which would make the
///   earlier accept/reject decision and this weighting redundant with
///   each other rather than complementary.
///
/// Throws [InvalidRegistrationWeightInput] if [rmsResidual] is negative
/// or non-finite, or if [residualHalfWeightRadius] is not positive, or
/// [minimumWeight] is outside `[0, 1]`.
double registrationQualityWeight(
  double rmsResidual, {
  double residualHalfWeightRadius = 1.5,
  double minimumWeight = 0.05,
}) {
  if (!rmsResidual.isFinite || rmsResidual < 0) {
    throw InvalidRegistrationWeightInput(
      'rmsResidual must be a non-negative finite number.',
    );
  }
  if (!residualHalfWeightRadius.isFinite || !(residualHalfWeightRadius > 0)) {
    throw InvalidRegistrationWeightInput(
      'residualHalfWeightRadius must be finite and positive.',
    );
  }
  if (!(minimumWeight >= 0) || minimumWeight > 1) {
    throw InvalidRegistrationWeightInput('minimumWeight must be in [0, 1].');
  }
  final double ratio = rmsResidual / residualHalfWeightRadius;
  final double weight = 1 / (1 + ratio * ratio);
  if (!weight.isFinite || weight < 0 || weight > 1) {
    throw InvalidRegistrationWeightInput(
      'Registration weighting produced an invalid result.',
    );
  }
  return weight < minimumWeight ? minimumWeight : weight;
}
