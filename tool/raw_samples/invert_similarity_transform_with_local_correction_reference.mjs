/// Reference implementation of local-residual-aware inverse similarity
/// transform — the piece that closes the gap between
/// `local_residual_correction_reference.mjs`'s own fitted correction
/// field (Work119/120) and `cfa_drizzle_reference.mjs`'s own splatting
/// geometry, which needs exactly this direction (source/target frame
/// position -> output/reference frame position) to know where each
/// input sample belongs on the shared output grid.
///
/// The true forward mapping this module inverts is:
///
/// `source = globalTransform(reference) + localCorrection(reference)`
///
/// `similarity_transform_math_reference.mjs`'s own `invertSimilarity
/// Transform` already inverts the *global-only* version of this exactly
/// (a plain rigid rotation/translation has a closed-form inverse — the
/// rotation matrix's own transpose). Once a position-dependent local
/// correction is added, the combined forward mapping is no longer
/// affine, and no closed-form inverse exists in general — this module
/// instead recovers the reference position via **fixed-point iteration**:
/// starting from the already-existing closed-form global-only inverse as
/// an initial guess, repeatedly asking "if I were at this candidate
/// reference position, where would the *combined* (global + local)
/// transform actually send me, and how far off is that from the real
/// source position I'm trying to invert?", then nudging the guess by
/// exactly that error and repeating.
///
/// **Why fixed-point iteration converges reliably here, without needing
/// a Newton solver or an analytically-derived Jacobian**: the local
/// correction field is, by `local_residual_correction_reference.mjs`'s
/// own design, both *smooth* (a fixed low-degree polynomial, incapable
/// of a sharp local gradient) and *bounded* (`maximumCorrectionMagnitude`
/// caps it, by default at 3 pixels) — the combined forward mapping is
/// therefore always close to the purely-global one, which is exactly
/// the condition under which simple fixed-point (Picard) iteration on a
/// contraction mapping converges, and converges fast: each iteration's
/// own error is itself bounded by how much the local correction differs
/// between two nearby points, which for a smooth low-degree polynomial
/// shrinks quickly as the guess approaches the true answer. A handful
/// of iterations (this module defaults to 4) is enough in practice for
/// the residual magnitudes this correction is meant to address (a few
/// pixels at most).

export class InvalidLocalCorrectionInversionInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidLocalCorrectionInversionInput';
  }
}

/// Builds a `(sourceX, sourceY) -> {x, y}` function — matching
/// `invertSimilarityTransform`'s own return shape exactly, so it is a
/// drop-in replacement wherever that function is currently used — that
/// additionally accounts for [localCorrectionField] (an object with an
/// `evaluate(x, y)` method returning `{dx, dy}`, matching
/// `fitLocalResidualCorrectionField`'s own return shape) layered on top
/// of [estimate]'s global similarity transform.
///
/// - [applyGlobalForward]: the existing `applySimilarityForward`
///   function (dependency-injected so this reference implementation
///   does not need to import `cfa_drizzle_reference.mjs`'s own sibling
///   module directly).
/// - [invertGlobalOnly]: the existing `invertSimilarityTransform`
///   function's own *already-computed* inverse for [estimate] — used
///   as this iteration's own starting guess.
/// - [iterationCount] (default `4`): number of fixed-point refinement
///   steps — see this module's own doc comment for why this converges
///   reliably in only a few iterations for this specific use case.
///
/// Throws {@link InvalidLocalCorrectionInversionInput} if
/// [iterationCount] is not a positive integer.
export function invertSimilarityTransformWithLocalCorrection(
  estimate,
  localCorrectionField,
  applyGlobalForward,
  invertGlobalOnly,
  { iterationCount = 4 } = {},
) {
  if (!Number.isInteger(iterationCount) || iterationCount < 1) {
    throw new InvalidLocalCorrectionInversionInput(
      'iterationCount must be a positive integer.',
    );
  }

  return (sourceX, sourceY) => {
    if (!Number.isFinite(sourceX) || !Number.isFinite(sourceY)) {
      throw new InvalidLocalCorrectionInversionInput(
        'Source coordinates must be finite.',
      );
    }
    let guess = invertGlobalOnly(sourceX, sourceY);
    if (!Number.isFinite(guess.x) || !Number.isFinite(guess.y)) {
      throw new InvalidLocalCorrectionInversionInput(
        'Initial inverse-transform guess must be finite.',
      );
    }
    for (let i = 0; i < iterationCount; i++) {
      const globalPrediction = applyGlobalForward(estimate, guess.x, guess.y);
      const correction = localCorrectionField.evaluate(guess.x, guess.y);
      const predictedSourceX = globalPrediction.x + correction.dx;
      const predictedSourceY = globalPrediction.y + correction.dy;
      if (![globalPrediction.x, globalPrediction.y, correction.dx, correction.dy,
        predictedSourceX, predictedSourceY].every(Number.isFinite)) {
        throw new InvalidLocalCorrectionInversionInput(
          'Local-correction inversion produced a non-finite prediction.',
        );
      }
      const errorX = sourceX - predictedSourceX;
      const errorY = sourceY - predictedSourceY;
      const nextX = guess.x + errorX;
      const nextY = guess.y + errorY;
      if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
        throw new InvalidLocalCorrectionInversionInput(
          'Local-correction inversion diverged to a non-finite point.',
        );
      }
      guess = { x: nextX, y: nextY };
    }
    return guess;
  };
}
