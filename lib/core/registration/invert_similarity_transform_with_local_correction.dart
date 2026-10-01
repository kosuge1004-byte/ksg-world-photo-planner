import 'local_residual_correction.dart'
    show LocalResidualCorrection, LocalResidualCorrectionField;
import 'similarity_transform_math.dart'
    show SimilarityTransformEstimate, applySimilarityForward;

/// Dart port of `tool/raw_samples/invert_similarity_transform_with_
/// local_correction_reference.mjs`.
///
/// Closes the gap between `local_residual_correction.dart`'s own fitted
/// correction field (Work119/120) and CFA drizzle's own splatting
/// geometry (`tiled_cfa_drizzle.dart`), which needs exactly this
/// direction (source/target frame position -> output/reference frame
/// position) to know where each input sample belongs on the shared
/// output grid.
///
/// `similarity_transform_math.dart`'s own [invertSimilarityTransform]
/// already inverts the *global-only* transform exactly (a plain rigid
/// rotation/translation has a closed-form inverse). Once a
/// position-dependent local correction is layered on top, the combined
/// forward mapping is no longer affine, and no closed-form inverse
/// exists in general — this module instead recovers the reference
/// position via **fixed-point iteration**.
///
/// See the Node reference's own doc comment for the full convergence
/// rationale, including a hand-verified round-trip numeric case
/// (inverting a position-dependent linear correction field, then
/// re-applying the combined forward mapping, recovering the original
/// source position to within `1e-4`).
///
/// This file has not been executed against the Dart SDK. It is a
/// careful line-by-line translation of the Node reference, which has
/// full test coverage. Run `test/invert_similarity_transform_with_
/// local_correction_test.dart` before relying on this in production.

class InvalidLocalCorrectionInversionInput extends ArgumentError {
  InvalidLocalCorrectionInversionInput(String super.message);
}

/// Builds a `(sourceX, sourceY) -> {x, y}` function — matching
/// `invertSimilarityTransform`'s own return shape exactly, so it is a
/// drop-in replacement wherever that function is currently used — that
/// additionally accounts for [localCorrectionField] layered on top of
/// [estimate]'s global similarity transform.
///
/// - [invertGlobalOnly]: `invertSimilarityTransform(estimate)`'s own
///   already-computed inverse — used as this iteration's own starting
///   guess.
/// - [iterationCount] (default `4`): number of fixed-point refinement
///   steps.
///
/// Throws [InvalidLocalCorrectionInversionInput] if [iterationCount] is
/// not a positive integer.
({double x, double y}) Function(double sourceX, double sourceY)
    invertSimilarityTransformWithLocalCorrection(
  SimilarityTransformEstimate estimate,
  LocalResidualCorrectionField localCorrectionField,
  ({double x, double y}) Function(double sourceX, double sourceY)
      invertGlobalOnly, {
  int iterationCount = 4,
}) {
  if (iterationCount < 1) {
    throw InvalidLocalCorrectionInversionInput(
      'iterationCount must be a positive integer.',
    );
  }

  return (double sourceX, double sourceY) {
    if (!sourceX.isFinite || !sourceY.isFinite) {
      throw InvalidLocalCorrectionInversionInput(
        'Source coordinates must be finite.',
      );
    }
    ({double x, double y}) guess = invertGlobalOnly(sourceX, sourceY);
    if (!guess.x.isFinite || !guess.y.isFinite) {
      throw InvalidLocalCorrectionInversionInput(
        'Initial inverse-transform guess must be finite.',
      );
    }
    for (int i = 0; i < iterationCount; i++) {
      final ({double x, double y}) globalPrediction = applySimilarityForward(
        estimate,
        guess.x,
        guess.y,
      );
      final LocalResidualCorrection correction =
          localCorrectionField.evaluate(guess.x, guess.y);
      final double predictedSourceX = globalPrediction.x + correction.dx;
      final double predictedSourceY = globalPrediction.y + correction.dy;
      if (!globalPrediction.x.isFinite ||
          !globalPrediction.y.isFinite ||
          !correction.dx.isFinite ||
          !correction.dy.isFinite ||
          !predictedSourceX.isFinite ||
          !predictedSourceY.isFinite) {
        throw InvalidLocalCorrectionInversionInput(
          'Local-correction inversion produced a non-finite prediction.',
        );
      }
      final double errorX = sourceX - predictedSourceX;
      final double errorY = sourceY - predictedSourceY;
      final double nextX = guess.x + errorX;
      final double nextY = guess.y + errorY;
      if (!nextX.isFinite || !nextY.isFinite) {
        throw InvalidLocalCorrectionInversionInput(
          'Local-correction inversion diverged to a non-finite point.',
        );
      }
      guess = (x: nextX, y: nextY);
    }
    return guess;
  };
}
