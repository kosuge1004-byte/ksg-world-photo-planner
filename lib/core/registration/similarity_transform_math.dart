/// Dart port of the pure-math portion of `cfa_drizzle_reference.mjs`:
/// `applySimilarityForward` and `invertSimilarityTransform`, split into
/// their own file since `cfa_drizzle_reference.mjs` itself (the CFA
/// accumulation/splatting logic) has not been ported to Dart yet (see
/// WORK39_PROGRESS.md's deliberate deferral, reaffirmed in
/// WORK50_PROGRESS.md), but this small, simple, already-thoroughly-
/// tested rotation math is needed now by `streak_persistence_classifier.
/// dart`'s sky-motion-consistency check. When `cfa_drizzle_reference.mjs`
/// is eventually ported, its Dart counterpart should import
/// [invertSimilarityTransform] from here rather than duplicating it,
/// matching the Node reference's own "one shared, tested implementation"
/// reasoning for this specific function.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it); it is a careful line-by-line
/// translation of the Node reference, which has full test coverage. Run
/// `test/similarity_transform_math_test.dart` (mirroring the relevant
/// Node fixtures from `cfa_drizzle_reference.test.mjs`) before relying on
/// this in production.

library;

import 'dart:math' as math;

/// A rigid (rotation + translation, no scale) transform in
/// `AffineSamplingTransform.similarity`'s parameter shape: `source =
/// center + R(rotation) * (output - center) + sourceOffset`. Any type
/// exposing these five getters — in particular
/// `StarSimilarityTransformEstimate` — can be used directly with
/// [applySimilarityForward] and [invertSimilarityTransform].
abstract interface class SimilarityTransformEstimate {
  double get rotationDegrees;
  double get sourceOffsetX;
  double get sourceOffsetY;
  double get centerX;
  double get centerY;
}

void _validateSimilarityEstimate(
  SimilarityTransformEstimate estimate,
) {
  if (<double>[
    estimate.rotationDegrees,
    estimate.sourceOffsetX,
    estimate.sourceOffsetY,
    estimate.centerX,
    estimate.centerY,
  ].any((double value) => !value.isFinite)) {
    throw ArgumentError(
      'Similarity transform parameters must be finite.',
    );
  }
}

void _validatePoint(double x, double y) {
  if (!x.isFinite || !y.isFinite) {
    throw ArgumentError(
        'Similarity transform point coordinates must be finite.');
  }
}

/// Applies [estimate] to a point, in the forward (reference/output ->
/// target/source) direction — the same direction
/// `AffineSamplingTransform.similarity` itself resamples in, and the
/// direction `star_similarity_transform_estimator_reference.mjs`'s
/// output is already shaped for directly.
({double x, double y}) applySimilarityForward(
  SimilarityTransformEstimate estimate,
  double x,
  double y,
) {
  _validateSimilarityEstimate(estimate);
  _validatePoint(x, y);
  final double radians = estimate.rotationDegrees * math.pi / 180;
  final double cosine = math.cos(radians);
  final double sine = math.sin(radians);
  final double ox = x - estimate.centerX;
  final double oy = y - estimate.centerY;
  return (
    x: estimate.centerX + cosine * ox - sine * oy + estimate.sourceOffsetX,
    y: estimate.centerY + sine * ox + cosine * oy + estimate.sourceOffsetY,
  );
}

/// Inverts a rigid (rotation + translation, no scale) transform
/// expressed in `AffineSamplingTransform.similarity`'s parameter shape,
/// producing the forward transform `output = center + R(-rotation) *
/// (source - center - sourceOffset)` — i.e. given a position in the
/// *source* frame, where it lands in the *output/reference* frame.
///
/// This is a plain rotation-matrix inverse (transpose = negate the
/// angle), exact for any rigid transform; no iteration or approximation
/// is involved.
({double x, double y}) Function(double sourceX, double sourceY)
    invertSimilarityTransform(SimilarityTransformEstimate estimate) {
  _validateSimilarityEstimate(estimate);
  final double radians = -estimate.rotationDegrees * math.pi / 180;
  final double cosine = math.cos(radians);
  final double sine = math.sin(radians);
  return (double sourceX, double sourceY) {
    _validatePoint(sourceX, sourceY);
    final double shiftedX = sourceX - estimate.sourceOffsetX - estimate.centerX;
    final double shiftedY = sourceY - estimate.sourceOffsetY - estimate.centerY;
    return (
      x: estimate.centerX + cosine * shiftedX - sine * shiftedY,
      y: estimate.centerY + sine * shiftedX + cosine * shiftedY,
    );
  };
}
