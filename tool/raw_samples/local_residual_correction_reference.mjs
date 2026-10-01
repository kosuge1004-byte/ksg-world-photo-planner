/// Reference implementation of local residual correction, layered on
/// top of an already-fitted global registration transform — addressing
/// S5 of the quality specification this project's stakeholder provided
/// ("まずglobal transformationで全体位置合わせを行い、その後必要な
/// 場合のみlocal residual correctionを行う...レンズ歪曲・光学系の
/// 微小変形...ただし過剰なワープは禁止").
///
/// This project's existing registration
/// (`star_transform_estimator_reference.mjs`) fits a single global
/// similarity transform (rotation + uniform scale + translation) per
/// frame pair and reports its own overall RMS residual, but has no way
/// to correct for *spatially-varying* residual error across the
/// field — e.g. mild lens distortion (which grows with distance from
/// the optical center, roughly quadratically for typical barrel/
/// pincushion distortion) or gentle optical-system flexure, both of
/// which leave systematically larger residuals near the frame's own
/// edges even after the best possible single global transform.
///
/// This module does **not** replace or modify the global transform
/// fit at all. It takes the *same* matched star pairs the global fit
/// already used, computes each match's own residual (how far the
/// globally-transformed reference position still is from its actual
/// target position), and fits a **low-degree 2-D polynomial** — degree
/// 2 by default (six terms per axis: `1, x, y, x^2, xy, y^2`) — to
/// those residuals as a smooth function of field position, via
/// ordinary least squares.
///
/// **Why a low-degree polynomial specifically, and why that structurally
/// prevents "excessive warping"**: a polynomial of fixed, low degree is
/// a *global*, smooth function of position — by construction, it cannot
/// produce sharp local excursions or fit to individual noisy star
/// measurements the way a purely local interpolation (nearest-neighbor
/// or per-point warping) could. The fitted correction necessarily varies
/// gently and predictably across the whole field, which is exactly the
/// character of the physical effects (lens distortion, gentle flexure)
/// this correction is meant to address — and structurally unable to
/// produce the kind of erratic, overfit local distortion the person who
/// requested this feature specifically warned against.
///
/// **Safety gates, both required before any correction is applied**:
/// - [minimumMatchesPerCoefficient]: refuses to fit if there are too
///   few star matches relative to the number of polynomial coefficients
///   being fit (an under-determined or barely-determined fit is prone to
///   fitting noise rather than genuine field-position-dependent
///   structure) — returns a "no correction" (all-zero) field instead.
/// - [maximumCorrectionMagnitude]: the fitted field's own predicted
///   correction is clamped to this many pixels at every position it is
///   evaluated at, regardless of what the underlying fit itself
///   produced — an explicit, unconditional ceiling on how large a
///   "local nudge" this module will ever apply, independent of how
///   well or poorly the underlying fit converged.

export class InvalidLocalResidualFitInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidLocalResidualFitInput';
  }
}

/// Evaluates the degree-2 polynomial basis `[1, x, y, x^2, xy, y^2]` at
/// `(x, y)`.
function polynomialBasis(x, y) {
  return [1, x, y, x * x, x * y, y * y];
}

const BASIS_TERM_COUNT = 6;

/// Solves the square linear system `matrix * solution = vector` via
/// Gaussian elimination with partial pivoting. [matrix] is a row-major
/// array of arrays (each an equal-length row); [vector] has one entry
/// per row. Mutates neither input (works on internal copies).
///
/// Throws {@link InvalidLocalResidualFitInput} if [matrix] is singular
/// (or numerically indistinguishable from singular) — the corresponding
/// fit is then treated as having failed, not silently producing a
/// wildly unstable result.
function solveLinearSystem(matrix, vector) {
  const n = matrix.length;
  const augmented = matrix.map((row, i) => [...row, vector[i]]);

  for (let pivotColumn = 0; pivotColumn < n; pivotColumn++) {
    let pivotRow = pivotColumn;
    let pivotMagnitude = Math.abs(augmented[pivotColumn][pivotColumn]);
    for (let row = pivotColumn + 1; row < n; row++) {
      const magnitude = Math.abs(augmented[row][pivotColumn]);
      if (magnitude > pivotMagnitude) {
        pivotRow = row;
        pivotMagnitude = magnitude;
      }
    }
    if (pivotMagnitude < 1e-12) {
      throw new InvalidLocalResidualFitInput(
        'Matrix is singular; cannot fit local residual polynomial.',
      );
    }
    if (pivotRow !== pivotColumn) {
      const swap = augmented[pivotColumn];
      augmented[pivotColumn] = augmented[pivotRow];
      augmented[pivotRow] = swap;
    }
    const pivotValue = augmented[pivotColumn][pivotColumn];
    for (let row = pivotColumn + 1; row < n; row++) {
      const factor = augmented[row][pivotColumn] / pivotValue;
      if (factor === 0) continue;
      for (let column = pivotColumn; column <= n; column++) {
        augmented[row][column] -= factor * augmented[pivotColumn][column];
      }
    }
  }

  const solution = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = augmented[row][n];
    for (let column = row + 1; column < n; column++) {
      sum -= augmented[row][column] * solution[column];
    }
    solution[row] = sum / augmented[row][row];
  }
  return solution;
}

/// Fits `targetValues` (one per entry of `points`, each `{x, y}`) as a
/// degree-2 polynomial of position via ordinary least squares (solving
/// the normal equations `(A^T A) coefficients = A^T targetValues`), and
/// returns the six fitted coefficients (matching [polynomialBasis]'s own
/// term order).
function fitPolynomialLeastSquares(points, targetValues) {
  const normalMatrix = Array.from(
    { length: BASIS_TERM_COUNT },
    () => new Array(BASIS_TERM_COUNT).fill(0),
  );
  const normalVector = new Array(BASIS_TERM_COUNT).fill(0);

  for (let i = 0; i < points.length; i++) {
    const basis = polynomialBasis(points[i].x, points[i].y);
    for (let row = 0; row < BASIS_TERM_COUNT; row++) {
      normalVector[row] += basis[row] * targetValues[i];
      for (let column = 0; column < BASIS_TERM_COUNT; column++) {
        normalMatrix[row][column] += basis[row] * basis[column];
      }
    }
  }

  return solveLinearSystem(normalMatrix, normalVector);
}


function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustLocalResidualSurvivors({
  points,
  residualXValues,
  residualYValues,
  coefficientsX,
  coefficientsY,
  minimumSurvivors,
}) {
  const errors = points.map((point, i) => {
    const basis = polynomialBasis(point.x, point.y);
    let predictedX = 0;
    let predictedY = 0;
    for (let term = 0; term < BASIS_TERM_COUNT; term++) {
      predictedX += basis[term] * coefficientsX[term];
      predictedY += basis[term] * coefficientsY[term];
    }
    const dx = residualXValues[i] - predictedX;
    const dy = residualYValues[i] - predictedY;
    return Math.sqrt(dx * dx + dy * dy);
  });
  const center = median(errors);
  const deviations = errors.map((error) => Math.abs(error - center));
  const mad = median(deviations);
  const sigma = mad * 1.4826;
  const tolerance = sigma > 0
    ? center + 4.5 * sigma
    : center + 1e-9 * Math.max(1, Math.abs(center));
  const survivors = errors
    .map((error, index) => ({ error, index }))
    .filter(({ error }) => error <= tolerance)
    .map(({ index }) => index);
  return survivors.length >= minimumSurvivors
    ? survivors
    : points.map((_, index) => index);
}

function evaluateFittedCorrection({
  x, y, centerX, centerY, scaleX, scaleY, coefficientsX, coefficientsY,
  maximumCorrectionMagnitude,
}) {
  const normalizedX = (x - centerX) / scaleX;
  const normalizedY = (y - centerY) / scaleY;
  const basis = polynomialBasis(normalizedX, normalizedY);
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < BASIS_TERM_COUNT; i++) {
    dx += basis[i] * coefficientsX[i];
    dy += basis[i] * coefficientsY[i];
  }
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new InvalidLocalResidualFitInput(
      'Local residual correction produced a non-finite value.',
    );
  }
  const magnitude = Math.sqrt(dx * dx + dy * dy);
  if (!Number.isFinite(magnitude)) {
    throw new InvalidLocalResidualFitInput(
      'Local residual correction magnitude is non-finite.',
    );
  }
  if (magnitude > maximumCorrectionMagnitude) {
    const scale = maximumCorrectionMagnitude / magnitude;
    dx *= scale;
    dy *= scale;
  }
  return { dx, dy };
}

function fitDoesNotWorsenMatchedRms({
  matches, centerX, centerY, scaleX, scaleY, coefficientsX, coefficientsY,
  maximumCorrectionMagnitude,
}) {
  let globalSquaredError = 0;
  let correctedSquaredError = 0;
  for (const match of matches) {
    globalSquaredError +=
      match.residualX * match.residualX + match.residualY * match.residualY;
    const correction = evaluateFittedCorrection({
      x: match.referenceX,
      y: match.referenceY,
      centerX, centerY, scaleX, scaleY, coefficientsX, coefficientsY,
      maximumCorrectionMagnitude,
    });
    const dx = match.residualX - correction.dx;
    const dy = match.residualY - correction.dy;
    correctedSquaredError += dx * dx + dy * dy;
  }
  const tolerance = 1e-12 * Math.max(1, globalSquaredError);
  return correctedSquaredError <= globalSquaredError + tolerance;
}

/// Fits a local residual correction field from [matches] (an array of
/// `{referenceX, referenceY, residualX, residualY}` — [residualX]/
/// [residualY] being how far the already-globally-transformed reference
/// position still differs from the actual target position, in the same
/// units/frame as [referenceX]/[referenceY]).
///
/// - [minimumMatchesPerCoefficient] (default `4`): with
///   `matches.length < 6 * minimumMatchesPerCoefficient` (6 coefficients
///   per axis), returns a field whose [evaluate] always returns
///   `{dx: 0, dy: 0}` — too few matches to trust a 6-term-per-axis fit.
/// - [maximumCorrectionMagnitude] (default `3`): the returned field's
///   own [evaluate] clamps its output vector's magnitude to this value
///   at every position, regardless of what the underlying fit itself
///   produced.
///
/// Returns `{evaluate(x, y), fitted}` — [fitted] is `false` whenever
/// [evaluate] is the always-zero fallback (either too few matches, or
/// the underlying least-squares fit failed, e.g. degenerate/collinear
/// match positions), `true` when a genuine fit was used.
///
/// Throws {@link InvalidLocalResidualFitInput} if
/// [minimumMatchesPerCoefficient] or [maximumCorrectionMagnitude] is not
/// positive.
export function fitLocalResidualCorrectionField(matches, {
  minimumMatchesPerCoefficient = 4,
  maximumCorrectionMagnitude = 3,
} = {}) {
  if (!(minimumMatchesPerCoefficient > 0)) {
    throw new InvalidLocalResidualFitInput(
      'minimumMatchesPerCoefficient must be positive.',
    );
  }
  if (!(maximumCorrectionMagnitude > 0)) {
    throw new InvalidLocalResidualFitInput(
      'maximumCorrectionMagnitude must be positive.',
    );
  }
  for (const match of matches) {
    if (![match.referenceX, match.referenceY, match.residualX, match.residualY]
        .every(Number.isFinite)) {
      throw new InvalidLocalResidualFitInput(
        'Local residual matches must contain only finite values.',
      );
    }
  }

  const zeroField = {
    evaluate: () => ({ dx: 0, dy: 0 }),
    fitted: false,
  };

  const minimumMatches = BASIS_TERM_COUNT * minimumMatchesPerCoefficient;
  if (matches.length < minimumMatches) {
    return zeroField;
  }

  // 座標を正規化してからフィットする(Work124で発見・修正): 実際の
  // 画像座標系(数千ピクセル規模)をそのまま2次多項式の基底
  // (x^2, xy, y^2)へ渡すと、正規方程式の対角成分に14桁以上のスケール
  // 差が生じ、doubleの有効桁数(15-17桁)の限界に近い、数値的に不安定
  // な状態になりうる。中心を引いてスケールで割ることで、正規化後の
  // 座標は常に[-1,1]程度に収まり、この問題を構造的に回避する。
  // evaluate側でも同じ正規化を適用してから多項式を評価するため、
  // 最終的に返される補正ベクトル自体(dx, dy)は、正規化の有無に
  // かかわらず数学的に同一になる——「同じ関数を、数値的に安定した
  // 基底で表現し直しているだけ」であり、フィットする関数の形自体は
  // 変わらない。
  const referenceXValues = matches.map((m) => m.referenceX);
  const referenceYValues = matches.map((m) => m.referenceY);
  const minX = Math.min(...referenceXValues);
  const maxX = Math.max(...referenceXValues);
  const minY = Math.min(...referenceYValues);
  const maxY = Math.max(...referenceYValues);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  // スケールが0(全点が同じx、または同じy)になるのを避けるため、
  // 最低でも1を使う(ゼロ除算の防止。正規化後の座標がその軸方向には
  // どのみち一定値になるだけで、フィット自体の正しさには影響しない)。
  const scaleX = Math.max(1, (maxX - minX) / 2);
  const scaleY = Math.max(1, (maxY - minY) / 2);

  const points = matches.map((m) => ({
    x: (m.referenceX - centerX) / scaleX,
    y: (m.referenceY - centerY) / scaleY,
  }));
  const residualXValues = matches.map((m) => m.residualX);
  const residualYValues = matches.map((m) => m.residualY);

  let coefficientsX;
  let coefficientsY;
  try {
    coefficientsX = fitPolynomialLeastSquares(points, residualXValues);
    coefficientsY = fitPolynomialLeastSquares(points, residualYValues);

    const survivorIndices = robustLocalResidualSurvivors({
      points,
      residualXValues,
      residualYValues,
      coefficientsX,
      coefficientsY,
      minimumSurvivors: Math.ceil(minimumMatches),
    });
    if (survivorIndices.length < points.length) {
      coefficientsX = fitPolynomialLeastSquares(
        survivorIndices.map((i) => points[i]),
        survivorIndices.map((i) => residualXValues[i]),
      );
      coefficientsY = fitPolynomialLeastSquares(
        survivorIndices.map((i) => points[i]),
        survivorIndices.map((i) => residualYValues[i]),
      );
    }
  } catch (error) {
    if (error instanceof InvalidLocalResidualFitInput) {
      return zeroField;
    }
    throw error;
  }

  if (coefficientsX.some((value) => !Number.isFinite(value)) ||
      coefficientsY.some((value) => !Number.isFinite(value))) {
    return zeroField;
  }

  if (!fitDoesNotWorsenMatchedRms({
    matches,
    centerX,
    centerY,
    scaleX,
    scaleY,
    coefficientsX,
    coefficientsY,
    maximumCorrectionMagnitude,
  })) {
    return zeroField;
  }

  return {
    evaluate: (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new InvalidLocalResidualFitInput(
          'Local residual evaluation coordinates must be finite.',
        );
      }
      return evaluateFittedCorrection({
        x, y, centerX, centerY, scaleX, scaleY, coefficientsX, coefficientsY,
        maximumCorrectionMagnitude,
      });
    },
    fitted: true,
  };
}
