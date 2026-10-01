/// Reference streak brightness-profile analyzer for Mobile Stack's
/// meteor mode.
///
/// A second, independent signal (alongside `streak_persistence_
/// classifier_reference.mjs`'s cross-frame motion check) for telling a
/// meteor apart from an aircraft: aircraft carry navigation lights that
/// blink (typically red/green/white strobes cycling roughly once or
/// twice a second), so a long-exposure aircraft trail is characteristically
/// *beaded* — alternating bright and near-background segments along its
/// length — while a meteor's light comes from one continuous ablation
/// event and its trail is smooth and continuously bright along its
/// length (commonly brightest at one end and fading, but always
/// continuous, never dropping back to background partway through).
///
/// This module only measures and characterizes the brightness profile
/// along a candidate streak; it does not decide "this is an aircraft" —
/// consistent with this project's meteor-mode design (see
/// `streak_candidate_detector_reference.mjs`'s and `streak_persistence_
/// classifier_reference.mjs`'s doc comments), the output is a signal for
/// the human review step or for combining with the other signals, not a
/// final verdict.

export class InvalidBrightnessProfileInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidBrightnessProfileInput';
  }
}

function sampleAt(source, x, y) {
  return source.samples[y * source.width + x];
}

function validateSource(source) {
  if (!Number.isInteger(source.width) || !Number.isInteger(source.height)
      || source.width <= 0 || source.height <= 0
      || source.samples.length !== source.width * source.height) {
    throw new InvalidBrightnessProfileInput(
      'Invalid source dimensions or sample count.',
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

/// Same robust median approach as the star and streak detectors
/// (deliberately duplicated, not imported — see
/// `streak_candidate_detector_reference.mjs`'s equivalent note). Only the
/// median is needed here (for background subtraction), not the full
/// sigma estimate, since this module's "on"/"off" threshold is adaptive
/// per streak (a fraction of that streak's own peak brightness) rather
/// than a fixed noise-sigma multiple.
function estimateBackgroundMedian(source, sampleStride) {
  const values = [];
  for (let y = 0; y < source.height; y += sampleStride) {
    for (let x = 0; x < source.width; x += sampleStride) {
      values.push(sampleAt(source, x, y));
    }
  }
  values.sort((a, b) => a - b);
  return percentile(values, 0.5);
}

/// Samples the maximum background-subtracted intensity within a
/// perpendicular slice of half-width `slabHalfWidth` around
/// `(centerX, centerY)`, in the direction perpendicular to
/// `(dirX, dirY)` (a unit vector along the streak). Using the max over a
/// slice, not a single interpolated point, makes the profile robust to
/// the streak not being perfectly centered on the ideal straight line
/// (real trails are rarely perfectly straight over their full length,
/// and the shape detector's estimated orientation carries some error).
function sampleSlabMax(
  source,
  centerX,
  centerY,
  dirX,
  dirY,
  slabHalfWidth,
  backgroundMedian,
) {
  const perpX = -dirY;
  const perpY = dirX;
  let maxValue = -Infinity;
  const steps = Math.max(1, Math.ceil(slabHalfWidth * 2));
  for (let step = 0; step <= steps; step++) {
    const offset = -slabHalfWidth + (2 * slabHalfWidth * step) / steps;
    const x = Math.round(centerX + perpX * offset);
    const y = Math.round(centerY + perpY * offset);
    if (x < 0 || y < 0 || x >= source.width || y >= source.height) continue;
    const value = sampleAt(source, x, y) - backgroundMedian;
    if (value > maxValue) maxValue = value;
  }
  return maxValue === -Infinity ? 0 : Math.max(0, maxValue);
}

/// Finds contiguous runs of `true` in `onFlags` at least `minRunLength`
/// samples long, merging runs separated by a `false` gap shorter than
/// `minGapLength` (treating a too-short dip as noise within one
/// continuous segment, not a real off-segment). Returns an array of
/// `{ startIndex, endIndex }` (inclusive) run ranges.
function findRuns(onFlags, minRunLength, minGapLength) {
  const rawRuns = [];
  let runStart = -1;
  for (let index = 0; index < onFlags.length; index++) {
    if (onFlags[index]) {
      if (runStart < 0) runStart = index;
    } else if (runStart >= 0) {
      rawRuns.push({ startIndex: runStart, endIndex: index - 1 });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    rawRuns.push({ startIndex: runStart, endIndex: onFlags.length - 1 });
  }

  // Merge runs separated by a too-short gap.
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

/// Analyzes the brightness profile of `streak` (a `{ endpoints, width }`
/// -shaped object, matching `StreakCandidate`) along its length within
/// `source` (the same `{ width, height, samples }` plane
/// `detectStreakCandidates` was run on).
///
/// Options:
/// - `stepPx` (default 0.5): spacing between profile samples along the
///   streak's length, in pixels.
/// - `slabHalfWidthPixels` (default `max(1.5, streak.width / 2 + 1)`):
///   half-width of the perpendicular search slice at each sample point.
/// - `relativeOnThreshold` (default 0.35): a sample counts as "on" if its
///   background-subtracted value is at least this fraction of the
///   profile's own peak background-subtracted value. Adaptive per streak
///   (rather than a fixed absolute or noise-sigma threshold) since
///   different candidates can have very different absolute brightness.
/// - `minOnRunPixels` (default 2): minimum contiguous "on" length, in
///   pixels along the streak, to count as a real bright segment rather
///   than noise.
/// - `minGapPixels` (default 2): minimum contiguous "off" length, in
///   pixels, to count as a real gap between segments rather than a small
///   dip within one continuous segment.
/// - `backgroundSampleStride` (default 4): subsampling stride for the
///   background median pass.
///
/// Returns:
/// - `profile`: the raw background-subtracted sample values, in order
///   from `endpoints[0]` to `endpoints[1]`.
/// - `positions`: each sample's `{x, y}` location, same order.
/// - `segments`: detected bright-run ranges as `{ startFraction,
///   endFraction }` (position along the streak, 0 to 1), sorted in
///   sampling order.
/// - `segmentCount`: `segments.length`.
/// - `likelyBlinking`: `segmentCount >= 2` — multiple distinct bright
///   segments separated by real gaps, the aircraft-navigation-light
///   pattern. `false` for zero or one segment (a smooth, continuous
///   trail, or too little signal to say).
/// - `longestGapFraction`: the longest off-gap between two kept segments,
///   as a fraction of the streak's sampled length (`0` if fewer than two
///   segments).
/// - `sufficientSamples`: `false` if the streak was too short to sample
///   meaningfully (fewer than 4 profile samples); when `false`, treat
///   `likelyBlinking` as inconclusive rather than a real "no" — it is
///   still computed (and will be `false`, since fewer than 2 segments
///   can be found in so few samples) but does not carry the same
///   evidentiary weight as a normal-length streak's result.
export function analyzeStreakBrightnessProfile(source, streak, options = {}) {
  validateSource(source);
  const stepPx = options.stepPx ?? 0.5;
  const slabHalfWidthPixels = options.slabHalfWidthPixels
    ?? Math.max(1.5, (streak.width ?? 2) / 2 + 1);
  const relativeOnThreshold = options.relativeOnThreshold ?? 0.35;
  const minOnRunPixels = options.minOnRunPixels ?? 2;
  const minGapPixels = options.minGapPixels ?? 2;
  const backgroundSampleStride = options.backgroundSampleStride ?? 4;

  const [start, end] = streak.endpoints;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const dirX = length > 1e-9 ? dx / length : 1;
  const dirY = length > 1e-9 ? dy / length : 0;

  const sampleCount = Math.max(1, Math.round(length / stepPx)) + 1;
  const backgroundMedian = estimateBackgroundMedian(
    source,
    Math.max(1, backgroundSampleStride),
  );

  const profile = new Array(sampleCount);
  const positions = new Array(sampleCount);
  for (let index = 0; index < sampleCount; index++) {
    const t = sampleCount === 1 ? 0 : index / (sampleCount - 1);
    const x = start.x + dx * t;
    const y = start.y + dy * t;
    positions[index] = { x, y };
    profile[index] = sampleSlabMax(
      source, x, y, dirX, dirY, slabHalfWidthPixels, backgroundMedian,
    );
  }

  const sufficientSamples = sampleCount >= 4;
  let peakValue = 0;
  for (const value of profile) {
    if (value > peakValue) peakValue = value;
  }
  const onThreshold = peakValue * relativeOnThreshold;
  const onFlags = profile.map((value) => value >= onThreshold
    && peakValue > 0);

  const minRunSamples = Math.max(1, Math.round(minOnRunPixels / stepPx));
  const minGapSamples = Math.max(1, Math.round(minGapPixels / stepPx));
  const runs = findRuns(onFlags, minRunSamples, minGapSamples);

  const segments = runs.map((run) => ({
    startFraction: sampleCount > 1 ? run.startIndex / (sampleCount - 1) : 0,
    endFraction: sampleCount > 1 ? run.endIndex / (sampleCount - 1) : 1,
  }));

  let longestGapFraction = 0;
  for (let index = 1; index < runs.length; index++) {
    const gapSamples = runs[index].startIndex - runs[index - 1].endIndex - 1;
    const gapFraction = sampleCount > 1 ? gapSamples / (sampleCount - 1) : 0;
    if (gapFraction > longestGapFraction) longestGapFraction = gapFraction;
  }

  return {
    profile,
    positions,
    segments,
    segmentCount: segments.length,
    likelyBlinking: segments.length >= 2,
    longestGapFraction,
    sufficientSamples,
  };
}
