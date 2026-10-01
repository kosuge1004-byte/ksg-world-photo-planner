/// Reference implementation of Gaussian-PSF-based sub-pixel centroid
/// refinement — addressing S4 of the quality specification this
/// project's stakeholder provided: `star_centroid_detector_
/// reference.mjs`'s own existing centroiding
/// (`_centroidWindow`/`centroidWindow`) is a plain intensity-weighted
/// centroid, not a PSF fit of any kind, despite the spec's own explicit
/// request ("単純な輝度重心だけに依存しない...適切なPSF fittingを
/// 行う").
///
/// This module does **not** replace or modify the existing centroiding
/// at all — it adds a small, independent *refinement* step, taking an
/// already-computed centroid (from the existing, unmodified detector)
/// as its own starting point and sharpening it using a **separable
/// Gaussian marginal fit**: sum the window's own pixel values along each
/// row to get a 1-D profile across x (and similarly down each column for
/// y — this works because a genuinely 2-D Gaussian PSF factors exactly
/// into the product of two independent 1-D Gaussians, one per axis), then
/// fit a parabola to the *logarithm* of the three points nearest the
/// profile's own peak. A Gaussian's own logarithm is exactly a parabola,
/// so this closed-form 3-point fit recovers the true sub-pixel peak
/// position without needing an iterative non-linear least-squares solver
/// (Levenberg-Marquardt or similar) this project does not have a proven
/// implementation of — the classic, long-established "parabolic/
/// quadratic interpolation on the log of a Gaussian profile" technique
/// used throughout astronomical centroiding for exactly this reason: a
/// closed-form answer, cheap enough to run on every detected star in
/// every frame.
///
/// **Why this can genuinely improve on the plain centroid**: an
/// intensity-weighted centroid is unbiased only for a perfectly
/// symmetric profile sampled densely enough relative to the pixel
/// grid — with a modest number of pixels per PSF (typical for a phone
/// camera's own sensor and lens), a plain centroid can pick up a small,
/// systematic pull toward whichever side of the star happens to have
/// more sampled flux due to pixelation, while a parabolic fit to the
/// profile's own shape is comparatively insensitive to that discretization
/// bias, since it fits the profile's own curvature rather than just its
/// weighted average position.
///
/// **When this refinement is skipped, falling back to the existing
/// centroid unchanged**: if the profile's own peak sits at the very edge
/// of the window (no interior neighbor on one side to fit against), if
/// any of the three points needed is not strictly positive (the log
/// would be undefined), or if the fitted parabola does not open downward
/// (the three points are not actually peaked — a genuinely flat, noisy,
/// or multi-peaked profile a Gaussian assumption does not describe well)
/// — in every one of these cases, this module returns the original,
/// already-computed centroid exactly, never a worse or fabricated
/// position.

export class InvalidPsfRefinementInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPsfRefinementInput';
  }
}

/// Fits a parabola to `(-1, logValues[0])`, `(0, logValues[1])`,
/// `(1, logValues[2])` and returns the fitted vertex's own x position
/// (a sub-pixel offset from `0`), or `null` if the parabola does not
/// open downward (the three points are not actually peaked at the
/// center one).
function parabolicVertexOffset(logValues) {
  const [left, center, right] = logValues;
  const denominator = left - 2 * center + right;
  // 分母が0以上(下に凸でない、つまり中心が最大でない)の場合、
  // 3点は放物線的なピークを描いていないため、フィットを無効とする。
  if (denominator >= 0) return null;
  const offset = 0.5 * (left - right) / denominator;
  return offset;
}

/// Refines a single centroid axis: given the window's own [profile]
/// (a 1-D array of background-subtracted, non-negative marginal sums,
/// one entry per integer position starting at [profileOriginIndex]) and
/// the existing centroid's own [initialPosition] on this axis, finds the
/// integer index nearest [initialPosition], fits a parabola to the log
/// of that index and its two immediate neighbors, and returns the
/// refined sub-pixel position — or [initialPosition] unchanged if
/// refinement is not possible (see this module's own doc comment for
/// when).
///
/// Throws {@link InvalidPsfRefinementInput} if [profile] has fewer than
/// 3 entries.
export function refineAxisWithGaussianMarginalFit(
  profile,
  profileOriginIndex,
  initialPosition,
) {
  if (!Array.isArray(profile) || profile.length < 3) {
    throw new InvalidPsfRefinementInput(
      'profile must have at least 3 entries.',
    );
  }
  const nearestIndex = Math.round(initialPosition) - profileOriginIndex;
  if (nearestIndex <= 0 || nearestIndex >= profile.length - 1) {
    // 中心候補がウィンドウの端にあり、両隣を参照できないため、
    // 精緻化を行わず既存の位置をそのまま返す。
    return initialPosition;
  }
  const left = profile[nearestIndex - 1];
  const center = profile[nearestIndex];
  const right = profile[nearestIndex + 1];
  if (!(left > 0) || !(center > 0) || !(right > 0)) {
    // 対数が定義できない(0以下の値がある)ため、精緻化を行わず既存の
    // 位置をそのまま返す。
    return initialPosition;
  }
  const logValues = [Math.log(left), Math.log(center), Math.log(right)];
  const offset = parabolicVertexOffset(logValues);
  if (offset === null) {
    return initialPosition;
  }
  // オフセットの絶対値が1を超える場合(理論上、隣接3点だけの放物線
  // フィットでは起こりにくいが、数値誤差等への安全策として)、
  // 精緻化結果を信用せず既存の位置をそのまま返す。
  if (Math.abs(offset) > 1) {
    return initialPosition;
  }
  return (nearestIndex + profileOriginIndex) + offset;
}

/// Computes background-subtracted marginal sums (row sums for the x
/// profile, column sums for the y profile) over the window
/// `[left, right] x [top, bottom]` (inclusive) of [source] (a
/// `{width, height, samples}`-shaped luminance plane, row-major),
/// subtracting [backgroundMedian] from every sample and clamping
/// negative results to `0` before summing.
function computeMarginalProfiles(
  source,
  left,
  right,
  top,
  bottom,
  backgroundMedian,
) {
  const width = right - left + 1;
  const height = bottom - top + 1;
  const xProfile = new Float64Array(width);
  const yProfile = new Float64Array(height);
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const value = Math.max(
        0,
        source.samples[y * source.width + x] - backgroundMedian,
      );
      xProfile[x - left] += value;
      yProfile[y - top] += value;
    }
  }
  return { xProfile, yProfile };
}

/// Refines [initialX]/[initialY] (an already-computed centroid, e.g.
/// from the existing `centroidWindow`) using a separable Gaussian
/// marginal fit over the window
/// `[peakX - windowRadius, peakX + windowRadius] x
/// [peakY - windowRadius, peakY + windowRadius]` (clamped to
/// [source]'s own bounds) of [source] — see this module's own doc
/// comment for the full technique and when refinement is skipped.
///
/// Returns `{x, y}`, each independently either the refined sub-pixel
/// position or the corresponding input position unchanged.
///
/// Throws {@link InvalidPsfRefinementInput} if [source]'s sample count
/// does not match its own declared dimensions, or [windowRadius] is not
/// a positive integer.
export function refineCentroidWithGaussianPsfFit({
  source,
  peakX,
  peakY,
  initialX,
  initialY,
  backgroundMedian,
  windowRadius,
}) {
  if (source.samples.length !== source.width * source.height) {
    throw new InvalidPsfRefinementInput(
      "source's sample count does not match its dimensions.",
    );
  }
  if (!Number.isInteger(windowRadius) || windowRadius < 1) {
    throw new InvalidPsfRefinementInput(
      'windowRadius must be a positive integer.',
    );
  }
  if ([...source.samples].some((value) => !Number.isFinite(value)) ||
      !Number.isFinite(initialX) ||
      !Number.isFinite(initialY) ||
      !Number.isFinite(backgroundMedian)) {
    throw new InvalidPsfRefinementInput(
      'PSF refinement requires finite luminance and centroid inputs.',
    );
  }
  if (!Number.isInteger(peakX) ||
      !Number.isInteger(peakY) ||
      peakX < 0 ||
      peakY < 0 ||
      peakX >= source.width ||
      peakY >= source.height) {
    throw new InvalidPsfRefinementInput(
      'PSF peak coordinates must lie inside the source image.',
    );
  }
  const left = Math.max(0, peakX - windowRadius);
  const right = Math.min(source.width - 1, peakX + windowRadius);
  const top = Math.max(0, peakY - windowRadius);
  const bottom = Math.min(source.height - 1, peakY + windowRadius);

  const { xProfile, yProfile } = computeMarginalProfiles(
    source,
    left,
    right,
    top,
    bottom,
    backgroundMedian,
  );

  const refinedX = refineAxisWithGaussianMarginalFit(
    Array.from(xProfile),
    left,
    initialX,
  );
  const refinedY = refineAxisWithGaussianMarginalFit(
    Array.from(yProfile),
    top,
    initialY,
  );

  return { x: refinedX, y: refinedY };
}
