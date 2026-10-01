/// Reference implementation of drizzle-output gap filling, for Mobile
/// Stack's CFA-domain drizzle pipeline (`cfa_drizzle_reference.mjs`,
/// `tiled_cfa_drizzle.dart`, Work85/87).
///
/// `cfaDrizzle`'s own output is, by design, sparse per channel: at any
/// position where a channel's accumulated `coverage` is zero, that
/// channel simply has no real data there yet (see `DrizzleAccumulator.
/// finalize`'s own doc comment — `value` is already a coverage-weighted
/// average wherever `coverage > 0`, and exactly `0` wherever it is not).
/// A regular Bayer-pattern demosaic algorithm
/// (`mobile_stack_adaptive_demosaic_reference.mjs`) is not the right
/// tool to finish this: it assumes a *fixed, regular* sampling pattern
/// (exactly one known channel per pixel, in a strict repeating grid),
/// which drizzled output does not have — coverage varies continuously
/// and irregularly depending on how many source frames' drops happened
/// to land where, at what sub-pixel offsets.
///
/// This module fills each channel's own gaps independently (a missing
/// red sample is never filled using green or blue data — the whole
/// point of CFA-domain drizzle is keeping each color channel's own real
/// measurements separate until the very end) via a coverage-weighted
/// local average: for a position whose own coverage is below
/// `minimumCoverage`, look at a `(2*kernelRadius+1)^2` neighborhood and
/// average that channel's value from whichever neighbors *do* have
/// sufficient coverage, weighting each neighbor's contribution by its
/// own coverage (a neighbor built from more accumulated drizzle data
/// contributes more than one built from just a sliver of overlap) — a
/// well-established, simple approach for finishing drizzle-combined
/// data, not a novel one, chosen specifically because it is easy to
/// reason about and verify, over a more elaborate gradient-aware scheme
/// that would carry more risk of a subtle error for the amount of
/// additional quality this project's initial validation could confirm.
///
/// This is *not* a full demosaic: it does not attempt to produce a
/// dense image whose every pixel is fully covered even for a
/// pathologically under-sampled region (no realistic drizzle input
/// should produce one, given adequate frame count and dithering, but
/// this module does not itself guarantee it) — a position with no
/// sufficiently-covered neighbor within `kernelRadius` is left as `0`,
/// not extrapolated further, and its own coverage is reported as `0`
/// (not silently reported as if real data were present there) so a
/// caller can distinguish "filled from real nearby data" from "truly
/// no data available".

export class InvalidGapFillInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidGapFillInput';
  }
}

function validateChannel(channel, width, height, label) {
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width <= 0 || height <= 0
      || !channel || channel.value.length !== width * height
      || channel.coverage.length !== width * height) {
    throw new InvalidGapFillInput(
      `${label} channel dimensions do not match width/height.`,
    );
  }
  if ([...channel.value].some((value) => !Number.isFinite(value))
      || [...channel.coverage].some(
        (coverage) => !Number.isFinite(coverage) || coverage < 0,
      )) {
    throw new InvalidGapFillInput(
      `${label} channel must contain finite values and finite non-negative coverage.`,
    );
  }
}

/// Fills the gaps in one channel's `{value, coverage}` pair (each a
/// flat, row-major array of length `width * height`, matching
/// `DrizzleResult`'s own shape) independently of every other channel.
///
/// Returns a new `{value, coverage}` pair of the same shape: a position
/// whose own `coverage >= minimumCoverage` is passed through completely
/// unchanged (both `value` and `coverage`); a position below that
/// threshold is replaced by the coverage-weighted average of whichever
/// neighbors within `kernelRadius` (Chebyshev distance — a square
/// neighborhood, matching this project's other local-window operations
/// such as `streak_candidate_detector_reference.mjs`'s own moving
/// average) *do* meet the threshold. The synthesized position's output
/// `coverage` deliberately remains `0`: coverage here means direct source
/// support, not interpolation confidence. This prevents downstream code from
/// mistaking a gap-filled value for a directly measured drizzle sample. If no
/// neighbor within range qualifies, value and coverage both remain `0`.
export function fillChannelGaps(channel, width, height, {
  kernelRadius = 2,
  minimumCoverage = 1e-6,
} = {}) {
  validateChannel(channel, width, height, 'input');
  if (!Number.isInteger(kernelRadius) || kernelRadius < 1) {
    throw new InvalidGapFillInput('kernelRadius must be a positive integer.');
  }
  if (!Number.isFinite(minimumCoverage) || minimumCoverage <= 0) {
    throw new InvalidGapFillInput(
      'minimumCoverage must be finite and positive.',
    );
  }
  const { value, coverage } = channel;
  const filledValue = new Float64Array(width * height);
  const filledCoverage = new Float64Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (coverage[index] >= minimumCoverage) {
        filledValue[index] = value[index];
        filledCoverage[index] = coverage[index];
        continue;
      }
      let weightedValueSum = 0;
      let coverageSum = 0;
      const minY = Math.max(0, y - kernelRadius);
      const maxY = Math.min(height - 1, y + kernelRadius);
      const minX = Math.max(0, x - kernelRadius);
      const maxX = Math.min(width - 1, x + kernelRadius);
      for (let ny = minY; ny <= maxY; ny++) {
        for (let nx = minX; nx <= maxX; nx++) {
          const neighborIndex = ny * width + nx;
          const neighborCoverage = coverage[neighborIndex];
          if (neighborCoverage < minimumCoverage) continue;
          weightedValueSum += value[neighborIndex] * neighborCoverage;
          coverageSum += neighborCoverage;
        }
      }
      if (coverageSum > 0) {
        filledValue[index] = weightedValueSum / coverageSum;
        // A synthesized value has no direct source coverage at this position.
        filledCoverage[index] = 0;
      }
      // else: stays 0/0, matching this module's own documented
      // "no qualifying neighbor -> leave as true zero, not extrapolated"
      // behavior.
    }
  }

  return { value: filledValue, coverage: filledCoverage };
}

/// Fills every channel of a `cfaDrizzle`-style `{width, height,
/// channels}` result (`channels` an array of `{value, coverage}` pairs,
/// one per CFA color — see `cfa_drizzle_reference.mjs`'s own
/// `CfaDrizzleResult` shape), independently via [fillChannelGaps].
export function fillDrizzleResultGaps(result, options = {}) {
  const { width, height, channels } = result;
  if (width <= 0 || height <= 0 || !Array.isArray(channels)) {
    throw new InvalidGapFillInput('Invalid drizzle result shape.');
  }
  return {
    width,
    height,
    channels: channels.map(
      (channel) => fillChannelGaps(channel, width, height, options),
    ),
  };
}
