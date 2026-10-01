/// Reference streak (meteor/satellite/aircraft trail candidate) detector
/// for Mobile Stack's meteor mode.
///
/// Unlike `star_centroid_detector_reference.mjs`, which actively rejects
/// elongated sources to keep only point-like stars, this module looks
/// specifically for them: connected regions of above-background
/// brightness that are long and thin, the shape a meteor, a satellite
/// pass, or an aircraft leaves across a single exposure.
///
/// This module deliberately does not attempt to classify a candidate as
/// "meteor" versus "satellite" versus "aircraft" versus "sensor
/// artifact" — reliably telling these apart from pixel data alone in a
/// single frame is not robust (a satellite crossing a long exposure and
/// a bright meteor can look very similar), and Mobile Stack's meteor mode
/// is explicitly designed around a human reviewing and selecting which
/// detected candidate(s) to keep (see processing_mode.dart's
/// "検出し、選んだ流星だけを背景へ合成します"). This module's job is
/// only to surface every plausible candidate for that review step, not
/// to make the final call.
///
/// Algorithm: robust background/threshold estimation (shared approach
/// with the star detector), connected-component labeling of
/// above-threshold pixels (flood fill, 8-connectivity), then a
/// whole-region second-moment shape analysis (not a small fixed window
/// like the star detector uses, since a streak's length varies widely
/// and can span many tens of pixels) to estimate each region's
/// orientation, length, and width, filtering for genuinely elongated,
/// sufficiently long regions, and finally a width-uniformity ("necking")
/// check that rejects regions shaped like a dumbbell — a real, observed
/// failure mode where two nearby point sources (typically two stars
/// close enough together for their PSF wings to bridge) get merged by
/// the flood fill into one falsely-elongated region. See
/// WORK43_PROGRESS.md for how this was found and its documented residual
/// limitations (very closely overlapping point sources can still pass).

export class InvalidStreakDetectionInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidStreakDetectionInput';
  }
}

/// A detected streak-shaped candidate region.
///
/// `centroidX`/`centroidY`: intensity-weighted centroid of the region.
/// `angleRadians`: the streak's orientation (the major axis direction),
/// in `(-pi/2, pi/2]`; a streak is a line, not an arrow, so there is no
/// meaningful "start versus end" from shape alone.
/// `length`: the region's extent along its major axis, in pixels
/// (specifically, `4 * sqrt(majorEigenvalue)`, a standard "extent" proxy
/// for a 2D distribution's spread along its principal axis).
/// `width`: the same, along the minor axis — how thick the streak is.
/// `elongation`: `(majorEigenvalue - minorEigenvalue) / (majorEigenvalue
/// + minorEigenvalue)`, the same rotation-invariant metric the star
/// detector's roundness gate uses, so a value near 1 means "very
/// elongated" here too (this module keeps *high*-elongation regions,
/// the opposite selection direction from the star detector).
/// `flux`: background-subtracted intensity sum over the region.
/// `pixelCount`: number of above-threshold pixels in the region.
/// `endpoints`: two `{x, y}` points approximating the streak's visible
/// extent, for drawing an overlay — the centroid projected `length / 2`
/// pixels in each direction along `angleRadians`, then clamped to the
/// region's actual bounding box (so a curved or irregular streak's
/// endpoints don't overshoot past pixels that were never part of it).
export class StreakCandidate {
  constructor({
    centroidX,
    centroidY,
    angleRadians,
    length,
    width,
    elongation,
    flux,
    pixelCount,
    endpoints,
  }) {
    this.centroidX = centroidX;
    this.centroidY = centroidY;
    this.angleRadians = angleRadians;
    this.length = length;
    this.width = width;
    this.elongation = elongation;
    this.flux = flux;
    this.pixelCount = pixelCount;
    this.endpoints = endpoints;
  }
}

function sampleAt(source, x, y) {
  return source.samples[y * source.width + x];
}

function validateSource(source) {
  if (!Number.isInteger(source.width) || !Number.isInteger(source.height)
      || source.width <= 0 || source.height <= 0
      || source.samples.length !== source.width * source.height) {
    throw new InvalidStreakDetectionInput(
      'Invalid streak-detection source dimensions or sample count.',
    );
  }
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round(fraction * (sortedValues.length - 1))),
  );
  return sortedValues[index];
}

/// Same robust median/MAD approach as the star detector, duplicated
/// (not imported) deliberately: the two modules' background-estimation
/// needs are currently identical, but coupling them via a shared import
/// would make it easy to accidentally change one detector's threshold
/// behavior while tuning the other. Revisit if they diverge further.
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
  const sigma = 1.4826 * percentile(deviations, 0.5);
  return { median, sigma: Math.max(sigma, 1e-9) };
}

const NEIGHBOR_OFFSETS_8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/// Labels connected components of above-threshold pixels via iterative
/// (explicit-stack, not recursive) flood fill, 8-connectivity. Returns an
/// array of pixel-index arrays, one per component. `maxRegionPixels`
/// bounds a single flood fill's cost (and is the mechanism that keeps a
/// large saturated area — cloud-lit haze, the moon entering frame, a
/// sensor-wide glow — from ballooning into an enormous "component" that
/// would dominate detection time and would never pass the elongation
/// filter anyway).
function labelConnectedComponents(source, threshold, maxRegionPixels) {
  const { width, height } = source;
  const visited = new Uint8Array(width * height);
  const components = [];
  const stack = [];

  for (let startIndex = 0; startIndex < visited.length; startIndex++) {
    if (visited[startIndex] || source.samples[startIndex] <= threshold) {
      continue;
    }
    const pixels = [];
    stack.length = 0;
    stack.push(startIndex);
    visited[startIndex] = 1;
    while (stack.length > 0) {
      const index = stack.pop();
      pixels.push(index);
      if (pixels.length >= maxRegionPixels) break;
      const x = index % width;
      const y = (index / width) | 0;
      for (const [dx, dy] of NEIGHBOR_OFFSETS_8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighborIndex = ny * width + nx;
        if (visited[neighborIndex]) continue;
        if (source.samples[neighborIndex] <= threshold) continue;
        visited[neighborIndex] = 1;
        stack.push(neighborIndex);
      }
    }
    components.push(pixels);
  }
  return components;
}

/// Computes the whole-region intensity-weighted centroid, second-moment
/// shape (orientation, length, width, elongation), and clamped endpoints
/// for one connected component.
function analyzeRegionShape(source, pixelIndices, background) {
  const { width } = source;
  let weightedX = 0;
  let weightedY = 0;
  let totalWeight = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const index of pixelIndices) {
    const x = index % width;
    const y = (index / width) | 0;
    const weight = Math.max(0, source.samples[index] - background.median);
    weightedX += weight * x;
    weightedY += weight * y;
    totalWeight += weight;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (totalWeight <= 0) return null;
  const centroidX = weightedX / totalWeight;
  const centroidY = weightedY / totalWeight;

  let secondX = 0;
  let secondY = 0;
  let secondXY = 0;
  for (const index of pixelIndices) {
    const x = index % width;
    const y = (index / width) | 0;
    const weight = Math.max(0, source.samples[index] - background.median);
    const ox = x - centroidX;
    const oy = y - centroidY;
    secondX += weight * ox * ox;
    secondY += weight * oy * oy;
    secondXY += weight * ox * oy;
  }
  secondX /= totalWeight;
  secondY /= totalWeight;
  secondXY /= totalWeight;

  const trace = secondX + secondY;
  const discriminant = Math.sqrt(
    Math.max(0, ((secondX - secondY) / 2) ** 2 + secondXY * secondXY),
  );
  const majorEigenvalue = trace / 2 + discriminant;
  const minorEigenvalue = trace / 2 - discriminant;
  const elongation = trace <= 1e-12
    ? 0
    : (majorEigenvalue - minorEigenvalue) / trace;

  // Orientation of the region's major axis, via the standard closed-form
  // formula for a 2D covariance/inertia tensor's principal-axis angle:
  // theta = 0.5 * atan2(2*secondXY, secondX - secondY). This is
  // preferred over deriving the angle from the major eigenvalue's
  // eigenvector (e.g. atan2(majorEigenvalue - secondX, secondXY))
  // because that approach subtracts two numbers that are nearly equal
  // whenever the region is close to axis-aligned (secondXY near 0),
  // which is a common, not edge, case for a streak — the eigenvector
  // formula becomes numerically unstable (atan2 of two near-zero,
  // essentially noise-dominated-sign values) exactly when it matters
  // most. This formula only ever differences secondX and secondY
  // directly, so it stays well-conditioned in that case.
  const angleRadians = 0.5 * Math.atan2(2 * secondXY, secondX - secondY);

  const length = 4 * Math.sqrt(Math.max(0, majorEigenvalue));
  const width_ = 4 * Math.sqrt(Math.max(0, minorEigenvalue));

  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);
  const half = length / 2;
  const endpoints = [
    {
      x: clamp(centroidX + cos * half, minX, maxX),
      y: clamp(centroidY + sin * half, minY, maxY),
    },
    {
      x: clamp(centroidX - cos * half, minX, maxX),
      y: clamp(centroidY - sin * half, minY, maxY),
    },
  ];

  return {
    centroidX,
    centroidY,
    angleRadians,
    length,
    width: width_,
    elongation,
    flux: totalWeight,
    pixelCount: pixelIndices.length,
    endpoints,
  };
}

function clamp(value, lower, upper) {
  return Math.min(upper, Math.max(lower, value));
}

/// Measures the region's perpendicular width at every integer position
/// along its major axis, by projecting each region pixel onto the axis
/// (rounding to the nearest integer position) and, at each occupied
/// position, measuring the range (max - min) of perpendicular
/// projections.
///
/// This directly reflects the region's actual pixel membership (not an
/// idealized straight-line assumption), so a region shaped like a
/// dumbbell — two round blobs bridged by a thin neck, the signature of
/// two or more nearby point sources (stars) accidentally merged by the
/// flood fill in `labelConnectedComponents`, rather than one genuine
/// continuous streak — shows up as a width profile with wide positions
/// near the blobs and one or more much narrower positions in between.
///
/// Uses one bin per integer axis position (not a fixed, coarser bin
/// count) deliberately: an earlier version of this function used a
/// small fixed number of bins spanning the region's whole length, which
/// could average a single-pixel-wide neck together with the wide bulge
/// columns immediately next to it into one bin, hiding the neck
/// entirely. A real neck can be as narrow as one pixel wide along the
/// axis (see WORK43_PROGRESS.md), so the sampling resolution has to
/// match that.
///
/// Returns an array of `{ axisFraction, width }` for populated positions
/// only, sorted by position along the axis (`axisFraction` in `[0, 1]`).
function measureWidthProfile(source, pixelIndices, centroidX, centroidY, cosAxis, sinAxis) {
  const { width } = source;
  let minAxis = Infinity;
  let maxAxis = -Infinity;
  const axisProjections = new Float64Array(pixelIndices.length);
  const perpProjections = new Float64Array(pixelIndices.length);
  for (let i = 0; i < pixelIndices.length; i++) {
    const index = pixelIndices[i];
    const x = index % width;
    const y = (index / width) | 0;
    const dx = x - centroidX;
    const dy = y - centroidY;
    const axis = dx * cosAxis + dy * sinAxis;
    const perp = -dx * sinAxis + dy * cosAxis;
    axisProjections[i] = axis;
    perpProjections[i] = perp;
    if (axis < minAxis) minAxis = axis;
    if (axis > maxAxis) maxAxis = axis;
  }
  const span = maxAxis - minAxis;
  if (span <= 1e-6) return [];

  // One bin per integer-rounded axis position along the actual pixel
  // span (not the second-moment-derived `length` estimate, which can
  // differ from the true pixel extent).
  const binCount = Math.max(1, Math.round(span) + 1);
  const binMinPerp = new Float64Array(binCount).fill(Infinity);
  const binMaxPerp = new Float64Array(binCount).fill(-Infinity);
  const binHasData = new Uint8Array(binCount);
  for (let i = 0; i < pixelIndices.length; i++) {
    let bin = Math.round(axisProjections[i] - minAxis);
    if (bin >= binCount) bin = binCount - 1;
    if (bin < 0) bin = 0;
    binHasData[bin] = 1;
    if (perpProjections[i] < binMinPerp[bin]) binMinPerp[bin] = perpProjections[i];
    if (perpProjections[i] > binMaxPerp[bin]) binMaxPerp[bin] = perpProjections[i];
  }

  const profile = [];
  for (let bin = 0; bin < binCount; bin++) {
    if (!binHasData[bin]) continue;
    profile.push({
      axisFraction: binCount > 1 ? bin / (binCount - 1) : 0,
      // +1: two pixels one apart (perpendicular projections differing
      // by exactly 1) are 2 pixels wide, not a zero-width line.
      width: binMaxPerp[bin] - binMinPerp[bin] + 1,
    });
  }
  return profile;
}

/// Finds contiguous runs of `true` in `flags` at least `minRunLength`
/// samples long, merging runs separated by a `false` gap shorter than
/// `minGapLength` (treating a brief dip as noise within one continuous
/// run, not a real separation). Returns an array of `{ startIndex,
/// endIndex }` (inclusive) run ranges.
///
/// Deliberately duplicated from `streak_brightness_profile_reference.
/// mjs`'s identical `findRuns` (used there for brightness segments, here
/// for width lobes) rather than imported — see this file's other
/// duplicated-helper notes (`estimateBackgroundStatistics`) for why:
/// keeping each detector's tuning independently adjustable without
/// coupling two unrelated gates to one shared implementation.
function findRuns(flags, minRunLength, minGapLength) {
  const rawRuns = [];
  let runStart = -1;
  for (let index = 0; index < flags.length; index++) {
    if (flags[index]) {
      if (runStart < 0) runStart = index;
    } else if (runStart >= 0) {
      rawRuns.push({ startIndex: runStart, endIndex: index - 1 });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    rawRuns.push({ startIndex: runStart, endIndex: flags.length - 1 });
  }

  const merged = [];
  for (const run of rawRuns) {
    const previous = merged[merged.length - 1];
    if (previous
        && run.startIndex - previous.endIndex - 1 < minGapLength) {
      previous.endIndex = run.endIndex;
    } else {
      merged.push({ ...run });
    }
  }

  return merged.filter(
    (run) => run.endIndex - run.startIndex + 1 >= minRunLength,
  );
}

/// Smooths a width profile with a 5-point (2 on each side) moving
/// average before lobe counting. This exists specifically because
/// projecting a discrete pixel grid onto a diagonal (non axis-aligned)
/// major axis produces a genuine, small, *repeating* (period-2) width
/// oscillation purely from pixel discretization geometry — a real
/// 45-degree streak's per-bin width can legitimately alternate between
/// two nearby values every other bin, with no defect involved at all.
/// See WORK46_PROGRESS.md for how this was found (a real diagonal-streak
/// false rejection during this gate's own testing, not a theoretical
/// concern). Note this smoothing does not need to fully cancel the
/// oscillation — `countSignificantWidthLobes` below only needs the
/// smoothed values to stay within one threshold band of each other, not
/// exactly equal, since it counts threshold-crossing runs rather than
/// comparing individual points to their immediate neighbors.
function smoothWidthProfile(widthProfile) {
  const n = widthProfile.length;
  if (n < 3) return widthProfile;
  const radius = 2;
  const smoothed = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const j = Math.min(n - 1, Math.max(0, i + offset));
      sum += widthProfile[j].width;
      count += 1;
    }
    smoothed[i] = {
      axisFraction: widthProfile[i].axisFraction,
      width: sum / count,
    };
  }
  return smoothed;
}

/// Counts the number of significant "lobes" (wide stretches) in a width
/// profile via threshold-based run detection: a bin counts as "wide" if
/// its (smoothed) width is at least `lobeThresholdRatio` times the
/// profile's own peak width, contiguous wide bins form one run, and runs
/// separated by a non-wide gap shorter than `minGapSamples` are merged
/// (treating a brief dip as noise within one lobe, not a real
/// separation) — the same run-detection structure already validated in
/// `streak_brightness_profile_reference.mjs`'s `findRuns`, applied here
/// to width instead of brightness.
///
/// A real streak's width profile stays close to its peak width
/// throughout (one wide run — one lobe), possibly narrowing only near
/// its very tips. A chain of several bridged point sources (Work43's
/// "necking" discovery, and Work45's finding that the necking gate alone
/// only partially catches a *moderate density* of blurred, multi-pixel
/// defects — see WORK46_PROGRESS.md) instead shows one wide bump per
/// source, separated by dips that may not be deep enough to trigger
/// `detectNeckingArtifact`'s single min-vs-max ratio check but are still
/// enough to break the "consistently wide" run into several.
///
/// This function was originally implemented via topographic-prominence
/// peak detection instead of threshold-based runs, but that approach had
/// a real bug found by this gate's own testing: projecting a discrete
/// pixel grid onto a diagonal (non-axis-aligned) major axis produces a
/// genuine, small, period-2 width oscillation from pixel discretization
/// geometry alone, and a peak-by-peak prominence walk that doesn't stop
/// at equal-height terrain ends up measuring each oscillation peak's
/// prominence against the streak's *far-away tapering ends* rather than
/// its immediate neighbors, false-rejecting genuine diagonal streaks
/// entirely. Threshold-based runs sidestep this: as long as the
/// oscillation stays above the threshold throughout (which it does,
/// being a small wobble around a consistently wide plateau), the whole
/// plateau reads as one contiguous run regardless of the local wobble.
function countSignificantWidthLobes(
  widthProfile,
  lobeThresholdRatio,
  minRunSamples,
  minGapSamples,
) {
  const smoothed = smoothWidthProfile(widthProfile);
  if (smoothed.length === 0) return 0;
  let maxWidth = 0;
  for (const point of smoothed) {
    if (point.width > maxWidth) maxWidth = point.width;
  }
  if (maxWidth <= 0) return 0;
  const threshold = maxWidth * lobeThresholdRatio;
  const wideFlags = smoothed.map((point) => point.width >= threshold);
  const runs = findRuns(wideFlags, minRunSamples, minGapSamples);
  return Math.max(runs.length, 1);
}

/// Checks a region's width profile for a "necking" (dumbbell) artifact:
/// an interior stretch of the streak that is much narrower than the
/// widest part of the region elsewhere. Interior means excluding the
/// first and last `endExclusionFraction` of the *populated bin* range —
/// deliberately, since a genuine meteor can legitimately taper toward a
/// fading tail near its true endpoints (the classic bolide brightness
/// pattern; see `streak_brightness_profile_reference.mjs`'s equivalent
/// note about brightness), and that must not be confused with a real
/// mid-streak neck.
///
/// Returns `{ hasNecking, minInteriorWidth, maxWidth }`.
function detectNeckingArtifact(widthProfile, minWidthUniformity, endExclusionFraction) {
  if (widthProfile.length === 0) {
    return { hasNecking: false, minInteriorWidth: 0, maxWidth: 0 };
  }
  let maxWidth = 0;
  for (const point of widthProfile) {
    if (point.width > maxWidth) maxWidth = point.width;
  }
  const interior = widthProfile.filter(
    (point) => point.axisFraction >= endExclusionFraction
      && point.axisFraction <= 1 - endExclusionFraction,
  );
  if (interior.length === 0 || maxWidth <= 0) {
    return { hasNecking: false, minInteriorWidth: maxWidth, maxWidth };
  }
  let minInteriorWidth = Infinity;
  for (const point of interior) {
    if (point.width < minInteriorWidth) minInteriorWidth = point.width;
  }
  return {
    hasNecking: minInteriorWidth / maxWidth < minWidthUniformity,
    minInteriorWidth,
    maxWidth,
  };
}

/// Detects streak-shaped candidates in `source` (a `{width, height,
/// samples}` single-channel plane) and returns them sorted by descending
/// flux.
///
/// Options:
/// - `thresholdSigma` (default 5): above-background acceptance threshold
///   for a pixel to join a region, in noise-sigma units.
/// - `minLength` (default 15): rejects regions whose major-axis extent
///   (see `StreakCandidate.length`) falls below this many pixels — the
///   primary filter distinguishing a streak from a compact star-like
///   blob. Tune based on the frame's resolution and typical meteor
///   angular velocity relative to exposure time.
/// - `minElongation` (default 0.8): rejects regions that aren't
///   sufficiently elongated (0 = round, approaching 1 = a line),
///   screening out large diffuse blobs (cloud edges, glare) that happen
///   to be long enough but aren't line-shaped.
/// - `minPixelCount` (default 8): rejects regions with too few
///   above-threshold pixels to trust a shape estimate.
/// - `maxCandidates` (default 50): caps the number of returned regions,
///   keeping only the brightest.
/// - `maxRegionPixels` (default 20000): caps a single connected
///   component's flood-fill cost; a region that hits this cap is very
///   unlikely to be a real streak candidate (see
///   `labelConnectedComponents`'s doc comment) and is filtered out
///   downstream by the elongation/length gates in essentially every
///   real case, but the cap exists as a hard cost bound regardless of
///   whether that filtering happens to catch it.
/// - `minWidthUniformity` (default 0.3): rejects a region whose
///   perpendicular width, at some point in its *interior* (excluding
///   the outer `neckingEndExclusionFraction` of its length at each end,
///   to tolerate a genuine meteor's tapering tail), drops below this
///   fraction of the region's widest point elsewhere — the "dumbbell"
///   signature of two nearby point sources (typically two stars close
///   enough together that their PSF halos bridge) accidentally merged
///   by the connected-component flood fill into one falsely-elongated
///   region, rather than a genuine continuous streak. This is a real,
///   observed failure mode (see WORK43_PROGRESS.md), not a
///   theoretical one. Set to `0` to disable this check entirely.
/// - `neckingEndExclusionFraction` (default 0.15): the fraction of the
///   region's populated axis range, at each end, excluded from the
///   necking check (see `minWidthUniformity`).
/// - `maxWidthProfileLobes` (default 1): rejects a region whose width
///   profile has more than this many significant local maxima ("lobes"
///   — see `countSignificantWidthLobes`), the signature of several
///   bridged point sources rather than one continuous streak. A
///   different, complementary check from `minWidthUniformity`: necking
///   catches a profile that dips *low* somewhere, while this catches a
///   profile with multiple separated *bumps* even when none of the
///   dips between them is deep enough to trigger the necking gate on
///   its own (see WORK46_PROGRESS.md, which found this matters at a
///   specific noise density the necking gate alone only partially
///   caught). Set to a larger value (or `Infinity`) to disable.
/// - `widthProfileLobeThresholdRatio` (default 0.7): a bin counts as
///   part of a "wide" lobe once its width reaches this fraction of the
///   profile's own widest point; contiguous wide bins form one lobe.
/// - `widthProfileLobeMinRunPixels` (default 3) /
///   `widthProfileLobeMinGapPixels` (default 3): minimum lobe length and
///   minimum gap length (in pixels along the axis) for
///   `countSignificantWidthLobes`'s run detection, analogous to
///   `streak_brightness_profile_reference.mjs`'s `minOnRunPixels`/
///   `minGapPixels`.
/// - `backgroundSampleStride` (default 4): subsampling stride used only
///   for the background statistics pass.
export function detectStreakCandidates(source, options = {}) {
  validateSource(source);
  const thresholdSigma = options.thresholdSigma ?? 5;
  const minLength = options.minLength ?? 15;
  const minElongation = options.minElongation ?? 0.8;
  const minPixelCount = options.minPixelCount ?? 8;
  const maxCandidates = options.maxCandidates ?? 50;
  const maxRegionPixels = options.maxRegionPixels ?? 20000;
  const minWidthUniformity = options.minWidthUniformity ?? 0.3;
  const neckingEndExclusionFraction = options.neckingEndExclusionFraction
    ?? 0.15;
  const maxWidthProfileLobes = options.maxWidthProfileLobes ?? 1;
  const widthProfileLobeThresholdRatio = options
    .widthProfileLobeThresholdRatio ?? 0.7;
  const widthProfileLobeMinRunPixels = options
    .widthProfileLobeMinRunPixels ?? 3;
  const widthProfileLobeMinGapPixels = options
    .widthProfileLobeMinGapPixels ?? 3;
  const backgroundSampleStride = options.backgroundSampleStride ?? 4;

  const background = estimateBackgroundStatistics(
    source,
    Math.max(1, backgroundSampleStride),
  );
  const threshold = background.median + thresholdSigma * background.sigma;
  const components = labelConnectedComponents(
    source,
    threshold,
    maxRegionPixels,
  );

  const candidates = [];
  for (const pixels of components) {
    if (pixels.length < minPixelCount) continue;
    const shape = analyzeRegionShape(source, pixels, background);
    if (shape === null) continue;
    if (shape.length < minLength) continue;
    if (shape.elongation < minElongation) continue;

    if (minWidthUniformity > 0 || Number.isFinite(maxWidthProfileLobes)) {
      const cosAxis = Math.cos(shape.angleRadians);
      const sinAxis = Math.sin(shape.angleRadians);
      const widthProfile = measureWidthProfile(
        source, pixels, shape.centroidX, shape.centroidY,
        cosAxis, sinAxis,
      );
      if (minWidthUniformity > 0) {
        const necking = detectNeckingArtifact(
          widthProfile, minWidthUniformity, neckingEndExclusionFraction,
        );
        if (necking.hasNecking) continue;
      }
      if (Number.isFinite(maxWidthProfileLobes)) {
        const lobeCount = countSignificantWidthLobes(
          widthProfile,
          widthProfileLobeThresholdRatio,
          widthProfileLobeMinRunPixels,
          widthProfileLobeMinGapPixels,
        );
        if (lobeCount > maxWidthProfileLobes) continue;
      }
    }

    candidates.push(new StreakCandidate(shape));
  }
  candidates.sort((a, b) => b.flux - a.flux);
  return candidates.slice(0, maxCandidates);
}
