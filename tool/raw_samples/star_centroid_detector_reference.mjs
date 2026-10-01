/// Reference star-source detector for Mobile Stack registration.
///
/// Finds point-like bright sources in a single-channel luminance plane
/// (typically a demosaiced green channel, or a luminance proxy built from
/// RGB) and reports sub-pixel centroids suitable for frame-to-frame
/// similarity-transform estimation.
///
/// The detector is intentionally conservative and dependency-free: a
/// robust (median/MAD) background estimate, local-maximum candidate
/// selection with non-maximum suppression, intensity-weighted sub-pixel
/// centroiding with a per-pixel noise floor (see `centroidWindow`'s doc
/// comment), and a small set of shape checks (minimum extent, rough
/// roundness) to reject single hot pixels and elongated non-star blobs
/// such as satellite or aircraft trails.
///
/// This is a first pass: it does not attempt full PSF fitting, does not
/// deblend overlapping sources, and its roundness/sharpness checks are
/// coarse. See WORK36_PROGRESS.md for known limitations and
/// WORK44_PROGRESS.md for the noise-floor mechanism and its own
/// documented residual limitation (a sufficiently blurred, multi-pixel
/// warm-pixel defect can still be indistinguishable from a real faint
/// star, since at that point it genuinely resembles one).

export class InvalidStarDetectionInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidStarDetectionInput';
  }
}

/// A detected point source.
///
/// `x` and `y` are sub-pixel centroid coordinates in the same pixel grid
/// as the input plane (0,0 at the center of the top-left pixel).
/// `flux` is the background-subtracted intensity sum used as the
/// centroiding weight, a convenient (not photometrically calibrated)
/// brightness proxy for ranking and matching.
/// `peakValue` is the raw (not background-subtracted) value of the
/// brightest pixel in the source, useful for saturation checks upstream.
export class DetectedStar {
  constructor({ x, y, flux, peakValue, roundness, sharpness }) {
    this.x = x;
    this.y = y;
    this.flux = flux;
    this.peakValue = peakValue;
    this.roundness = roundness;
    this.sharpness = sharpness;
  }
}

function sampleAt(source, x, y) {
  return source.samples[y * source.width + x];
}

function validateSource(source) {
  if (!Number.isInteger(source.width) || !Number.isInteger(source.height)
      || source.width <= 0 || source.height <= 0
      || source.samples.length !== source.width * source.height) {
    throw new InvalidStarDetectionInput(
      'Invalid star-detection source dimensions or sample count.',
    );
  }
  if ([...source.samples].some((value) => !Number.isFinite(value))) {
    throw new InvalidStarDetectionInput(
      'Star-detection source must contain only finite luminance samples.',
    );
  }
}

/// Robust background level and noise estimate via median and median
/// absolute deviation (MAD), computed over a stride-subsampled set of
/// pixels for speed on large planes while remaining robust to the bright,
/// sparse pixels that stars themselves contribute.
function estimateBackgroundStatistics(source, sampleStride) {
  const values = [];
  for (let y = 0; y < source.height; y += sampleStride) {
    for (let x = 0; x < source.width; x += sampleStride) {
      values.push(sampleAt(source, x, y));
    }
  }
  values.sort((a, b) => a - b);
  const median = percentile(values, 0.5);
  const deviations = values.map((value) => Math.abs(value - median));
  deviations.sort((a, b) => a - b);
  // 1.4826 converts MAD to a standard-deviation-equivalent for normally
  // distributed noise, the conventional robust-statistics constant.
  const sigma = 1.4826 * percentile(deviations, 0.5);
  return { median, sigma: Math.max(sigma, 1e-9) };
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round(fraction * (sortedValues.length - 1))),
  );
  return sortedValues[index];
}

/// Finds local-maximum candidate pixels whose value exceeds
/// `background.median + thresholdSigma * background.sigma`, using a
/// `(2 * localMaxRadius + 1)`-square neighborhood test.
function findLocalMaximumCandidates({
  source,
  background,
  thresholdSigma,
  localMaxRadius,
}) {
  const threshold = background.median + thresholdSigma * background.sigma;
  const candidates = [];
  for (let y = localMaxRadius; y < source.height - localMaxRadius; y++) {
    for (let x = localMaxRadius; x < source.width - localMaxRadius; x++) {
      const value = sampleAt(source, x, y);
      if (value <= threshold) continue;
      let isLocalMaximum = true;
      for (let dy = -localMaxRadius; dy <= localMaxRadius && isLocalMaximum;
        dy++) {
        for (let dx = -localMaxRadius; dx <= localMaxRadius; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (sampleAt(source, x + dx, y + dy) > value) {
            isLocalMaximum = false;
            break;
          }
        }
      }
      if (isLocalMaximum) {
        candidates.push({ x, y, value });
      }
    }
  }
  return candidates;
}

/// Computes an intensity-weighted sub-pixel centroid and shape diagnostics
/// within a square window around an integer-pixel peak.
///
/// `roundness` is a rotation-invariant elongation measure derived from the
/// eigenvalues of the windowed second-moment matrix; 0 is a perfectly
/// round source and values approach 1 for a strongly elongated one (e.g.
/// a satellite trail, at any orientation), so callers can reject blobs
/// above a roundness threshold.
/// `sharpness` is the fraction of the window's background-subtracted flux
/// contributed by the immediate 3x3 neighborhood of the peak; an isolated
/// single hot pixel scores near 1, while a real several-pixel-wide stellar
/// PSF scores lower, so callers can reject blobs above a sharpness
/// threshold.
function centroidWindow({
  source, peakX, peakY, background, windowRadius, noiseFloorSigma,
}) {
  let weightedX = 0;
  let weightedY = 0;
  let totalWeight = 0;
  let peakValue = -Infinity;
  let innerWeight = 0;
  let coveredPixels = 0;
  const left = Math.max(0, peakX - windowRadius);
  const right = Math.min(source.width - 1, peakX + windowRadius);
  const top = Math.max(0, peakY - windowRadius);
  const bottom = Math.min(source.height - 1, peakY + windowRadius);
  // A pixel only contributes weight once it clears this floor above the
  // background median, not merely once it is nonzero. Without this,
  // ordinary background noise fluctuations elsewhere in the window (each
  // individually tiny, but numerous across a ~(2*windowRadius+1)^2-pixel
  // window) sum into a nonzero contribution to `totalWeight` and dilute
  // `innerWeight / totalWeight` (the sharpness metric): a real single-
  // pixel hot/warm pixel's flux is genuinely concentrated in one pixel,
  // but enough scattered sub-threshold noise elsewhere in the window can
  // still push its *measured* sharpness below `maxSharpness`, letting it
  // slip through as a false star detection. See WORK44_PROGRESS.md for
  // how this was found (empirically, not theoretically) and measured.
  const noiseFloor = noiseFloorSigma * background.sigma;

  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const raw = sampleAt(source, x, y);
      peakValue = Math.max(peakValue, raw);
      const weight = Math.max(0, raw - background.median - noiseFloor);
      if (weight <= 0) continue;
      weightedX += weight * x;
      weightedY += weight * y;
      totalWeight += weight;
      coveredPixels += 1;
      if (Math.abs(x - peakX) <= 1 && Math.abs(y - peakY) <= 1) {
        innerWeight += weight;
      }
    }
  }
  if (totalWeight <= 0) return null;

  // Second moments about the centroid, used for the roundness estimate.
  const centroidX = weightedX / totalWeight;
  const centroidY = weightedY / totalWeight;
  let secondX = 0;
  let secondY = 0;
  let secondXY = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const raw = sampleAt(source, x, y);
      const weight = Math.max(0, raw - background.median - noiseFloor);
      if (weight <= 0) continue;
      const ox = x - centroidX;
      const oy = y - centroidY;
      secondX += weight * ox * ox;
      secondY += weight * oy * oy;
      secondXY += weight * ox * oy;
    }
  }
  secondX /= totalWeight;
  secondY /= totalWeight;
  secondXY /= totalWeight;
  // Elongation from the eigenvalues of the 2x2 second-moment (covariance)
  // matrix [[secondX, secondXY], [secondXY, secondY]], not merely the
  // difference between the axis-aligned x and y moments: a source
  // elongated along a diagonal (e.g. a satellite trail crossing the frame
  // at 45 degrees) can have secondX == secondY while still being highly
  // elongated, with the anisotropy only visible in the secondXY
  // cross-term. Using the eigenvalues makes the roundness estimate
  // rotation-invariant.
  const trace = secondX + secondY;
  const discriminant = Math.sqrt(
    Math.max(0, ((secondX - secondY) / 2) ** 2 + secondXY * secondXY),
  );
  const majorEigenvalue = trace / 2 + discriminant;
  const minorEigenvalue = trace / 2 - discriminant;
  const roundness = trace <= 1e-12
    ? 0
    : (majorEigenvalue - minorEigenvalue) / trace;
  const sharpness = totalWeight <= 0 ? 1 : innerWeight / totalWeight;

  return {
    x: centroidX,
    y: centroidY,
    flux: totalWeight,
    peakValue,
    roundness,
    sharpness,
    coveredPixels,
  };
}

/// Detects point sources in `source` (a `{width, height, samples}`
/// single-channel plane) and returns them sorted by descending flux.
///
/// Options:
/// - `thresholdSigma` (default 6): local-maximum acceptance threshold
///   above the robust background, in noise-sigma units.
/// - `localMaxRadius` (default 1): neighborhood radius for the initial
///   local-maximum test.
/// - `windowRadius` (default 4): centroiding/shape window radius; should
///   comfortably cover the expected PSF footprint.
/// - `minSeparation` (default `2 * windowRadius`): minimum pixel distance
///   enforced between accepted centroids during non-maximum suppression.
/// - `maxRoundness` (default 0.6): rejects candidates elongated beyond
///   this threshold (0 = round, 1 = a line), which screens out most
///   satellite/aircraft trails and read-noise streaks.
/// - `maxSharpness` (default 0.92): rejects candidates whose flux is
///   almost entirely inside the immediate 3x3 neighborhood, which
///   screens out isolated single-pixel hot/warm pixels.
/// - `minCoveredPixels` (default 2): rejects candidates with fewer than
///   this many above-background pixels in the window, another guard
///   against single-pixel defects.
/// - `noiseFloorSigma` (default 1.0): a pixel only contributes weight to
///   centroiding, flux, shape, and sharpness once it exceeds
///   `background.median + noiseFloorSigma * background.sigma`, not
///   merely once it is above the median. Without this floor, ordinary
///   background noise fluctuations scattered across the centroiding
///   window (individually tiny, but numerous) dilute the sharpness
///   metric enough that a genuinely single-pixel hot/warm pixel can
///   measure as less sharp than it really is and slip past
///   `maxSharpness` — an effect only visible with realistic background
///   noise present, not in a clean synthetic test (see
///   WORK44_PROGRESS.md). Set to `0` to restore the original
///   any-positive-value-counts behavior.
/// - `maxStars` (default 200): caps the number of returned sources,
///   keeping only the brightest.
/// - `backgroundSampleStride` (default 4): subsampling stride used only
///   for the background statistics pass, not for detection itself.
export function detectStars(source, options = {}) {
  validateSource(source);
  const thresholdSigma = options.thresholdSigma ?? 6;
  const localMaxRadius = options.localMaxRadius ?? 1;
  const windowRadius = options.windowRadius ?? 4;
  const minSeparation = options.minSeparation ?? 2 * windowRadius;
  const maxRoundness = options.maxRoundness ?? 0.6;
  const maxSharpness = options.maxSharpness ?? 0.92;
  const minCoveredPixels = options.minCoveredPixels ?? 2;
  const noiseFloorSigma = options.noiseFloorSigma ?? 1.0;
  const maxStars = options.maxStars ?? 200;
  const backgroundSampleStride = options.backgroundSampleStride ?? 4;

  if (!Number.isFinite(thresholdSigma) ||
      thresholdSigma < 0 ||
      !Number.isInteger(localMaxRadius) ||
      localMaxRadius < 0 ||
      !Number.isInteger(windowRadius) ||
      windowRadius < 1 ||
      !Number.isInteger(minSeparation) ||
      minSeparation < 0 ||
      !Number.isFinite(maxRoundness) ||
      maxRoundness < 0 ||
      !Number.isFinite(maxSharpness) ||
      maxSharpness < 0 ||
      !Number.isInteger(minCoveredPixels) ||
      minCoveredPixels < 0 ||
      !Number.isFinite(noiseFloorSigma) ||
      noiseFloorSigma < 0 ||
      !Number.isInteger(maxStars) ||
      maxStars < 0 ||
      !Number.isInteger(backgroundSampleStride) ||
      backgroundSampleStride < 1) {
    throw new InvalidStarDetectionInput(
      'Star-detection parameters must be finite and within valid ranges.',
    );
  }

  if (source.width <= 2 * windowRadius || source.height <= 2 * windowRadius) {
    return [];
  }

  const background = estimateBackgroundStatistics(
    source,
    Math.max(1, backgroundSampleStride),
  );
  const candidates = findLocalMaximumCandidates({
    source,
    background,
    thresholdSigma,
    localMaxRadius,
  });
  candidates.sort((a, b) => b.value - a.value);

  const accepted = [];
  const minSeparationSquared = minSeparation * minSeparation;
  for (const candidate of candidates) {
    if (accepted.length >= maxStars * 4) break; // bound worst-case cost
    let tooClose = false;
    for (const existing of accepted) {
      const dx = existing.x - candidate.x;
      const dy = existing.y - candidate.y;
      if (dx * dx + dy * dy < minSeparationSquared) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const shaped = centroidWindow({
      source,
      peakX: candidate.x,
      peakY: candidate.y,
      background,
      windowRadius,
      noiseFloorSigma,
    });
    if (shaped === null) continue;
    if (shaped.coveredPixels < minCoveredPixels) continue;
    if (shaped.roundness > maxRoundness) continue;
    if (shaped.sharpness > maxSharpness) continue;

    accepted.push({
      x: shaped.x,
      y: shaped.y,
      flux: shaped.flux,
      peakValue: shaped.peakValue,
      roundness: shaped.roundness,
      sharpness: shaped.sharpness,
    });
  }

  accepted.sort((a, b) => b.flux - a.flux);
  return accepted
    .slice(0, maxStars)
    .map((star) => new DetectedStar(star));
}
