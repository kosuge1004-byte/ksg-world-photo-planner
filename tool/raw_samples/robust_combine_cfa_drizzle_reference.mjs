/// Reference implementation of CFA-domain robust outlier rejection
/// across frames — addressing a real gap in this project's CFA drizzle
/// pipeline: `cfa_drizzle_reference.mjs`'s own single-pass accumulator
/// (`drizzle_accumulator_reference.mjs`) blindly sums every frame's
/// weighted contribution into each output pixel, with no rejection of
/// any kind. A cosmic ray hit, a satellite or aircraft trail crossing a
/// single frame, a residual hot pixel, or any other single-frame,
/// single-position anomaly gets averaged straight into the final stack,
/// diluted but never actually removed.
///
/// This module does **not** modify the existing, already-tested
/// `cfaDrizzle`/`DrizzleAccumulator` core at all. Instead, it combines
/// *N separate, per-frame* drizzle results (each produced by calling
/// the existing, unmodified `cfaDrizzle` once per frame, rather than
/// once for all frames together) via a robust statistic instead of a
/// plain weighted sum:
///
/// - [robustCombineCfaDrizzleResults] takes an array of per-frame
///   `CfaDrizzleResult`-shaped objects (`{width, height, channels}`,
///   each `channels` entry a `{value, coverage}` pair — the same shape
///   `cfaDrizzle` itself already returns), and for every output pixel
///   and channel, looks across whichever frames actually have coverage
///   there.
/// - With fewer than [minFramesForRejection] contributing frames at a
///   given position, no rejection is attempted at all — just a
///   coverage-weighted mean of whatever is available. This directly
///   protects against the failure mode the person who requested this
///   feature specifically warned about ("本物の星や微細構造を外れ値と
///   して除去しないこと" — don't reject real stars or fine structure as
///   outliers): with too few samples, there is no statistically
///   meaningful way to distinguish a genuine bright star (present in
///   several/most frames, since a well-registered star should appear at
///   the same drizzled position in nearly every frame) from a one-off
///   anomaly, so no attempt is made to.
/// - With enough contributing frames, a robust center (the **median**
///   of the contributing values — not the mean, specifically because a
///   mean is itself sensitive to the very outliers being rejected,
///   while the median is not, as long as outliers are a minority) and a
///   robust spread (MAD, median absolute deviation, scaled by the
///   usual 1.4826 constant so it estimates a standard deviation for
///   normally-distributed data) are computed, and any value more than
///   [sigmaHigh] MAD-derived-sigmas above or [sigmaLow] sigmas below the
///   median is excluded before the final coverage-weighted mean is
///   taken over the survivors. [sigmaLow] and [sigmaHigh] are
///   deliberately separate parameters (not one shared threshold):
///   astrophotography noise/defect patterns are usually asymmetric — a
///   cosmic ray hit or hot pixel produces an anomalously *high* value,
///   while an anomalously *low* value is comparatively rare and usually
///   more likely to be a real, if unusually faint, measurement (e.g. a
///   frame with a transient cloud or slightly worse transparency at
///   that position) — so the two directions can, and by default do,
///   use different tolerances.
///
/// A star that genuinely appears in most frames survives here as
/// intended: a robust center anchored to the *majority* of frames
/// naturally keeps a value most frames agree on, and MAD-based rejection
/// only excludes minority deviations — so as long as a star is present
/// (even slightly shifted by registration residual) in a comfortable
/// majority of contributing frames, its own drizzled brightness there
/// remains the accepted center, not something rejected. What gets
/// rejected is specifically a value only one (or a small minority of)
/// frame(s) contributed, deviating sharply from what every other frame
/// agrees on at that exact position — precisely the profile of a
/// single-frame transient artifact, not a real, persistent astronomical
/// signal.

export class InvalidRobustCombineInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRobustCombineInput';
  }
}

function median(values) {
  const sorted = Float64Array.from(values).sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const MAD_TO_SIGMA = 1.4826;

/// Combines [perFrameResults] (each a `cfaDrizzle`-shaped
/// `{width, height, channels}` result for one individual frame, all
/// sharing the same `width`/`height`/channel count) into a single
/// combined result of the same shape, applying robust, per-pixel,
/// per-channel outlier rejection across frames — see this module's own
/// doc comment for the full design.
///
/// - [minCoverage] (default `1e-6`): a frame's own value at a position
///   is only considered "contributing" there if its own coverage
///   exceeds this.
/// - [minFramesForRejection] (default `4`): fewer contributing frames
///   than this at a position skips rejection entirely for that
///   position (see this module's own doc comment for why).
/// - [sigmaLow]/[sigmaHigh] (defaults `4`/`3`): MAD-derived-sigma
///   rejection thresholds below/above the median.
///
/// Throws {@link InvalidRobustCombineInput} if [perFrameResults] is
/// empty, if any two entries have mismatched dimensions or channel
/// count, or if [minFramesForRejection] is less than `2`.
export function robustCombineCfaDrizzleResults(perFrameResults, {
  minCoverage = 1e-6,
  minFramesForRejection = 4,
  sigmaLow = 4,
  sigmaHigh = 3,
} = {}) {
  if (!Array.isArray(perFrameResults) || perFrameResults.length === 0) {
    throw new InvalidRobustCombineInput(
      'At least one per-frame drizzle result is required.',
    );
  }
  if (!Number.isInteger(minFramesForRejection) || minFramesForRejection < 2) {
    throw new InvalidRobustCombineInput(
      'minFramesForRejection must be an integer >= 2.',
    );
  }
  if (!Number.isFinite(minCoverage) || minCoverage < 0) {
    throw new InvalidRobustCombineInput(
      'minCoverage must be finite and non-negative.',
    );
  }
  if (!Number.isFinite(sigmaLow) ||
      !Number.isFinite(sigmaHigh) ||
      sigmaLow <= 0 ||
      sigmaHigh <= 0) {
    throw new InvalidRobustCombineInput(
      'sigmaLow and sigmaHigh must be finite and positive.',
    );
  }
  const first = perFrameResults[0];
  const { width, height } = first;
  const channelCount = first.channels.length;
  if (!(width > 0) || !(height > 0) || !(channelCount > 0)) {
    throw new InvalidRobustCombineInput(
      'Per-frame drizzle dimensions and channel count must be positive.',
    );
  }
  const pixelCount = width * height;
  for (const result of perFrameResults) {
    if (result.width !== width || result.height !== height) {
      throw new InvalidRobustCombineInput(
        'All per-frame results must share the same dimensions.',
      );
    }
    if (result.channels.length !== channelCount) {
      throw new InvalidRobustCombineInput(
        'All per-frame results must have the same channel count.',
      );
    }
    for (const channel of result.channels) {
      if (channel.value.length !== pixelCount ||
          channel.coverage.length !== pixelCount) {
        throw new InvalidRobustCombineInput(
          'Per-frame drizzle channel lengths must match image dimensions.',
        );
      }
      if ([...channel.value].some((value) => !Number.isFinite(value)) ||
          [...channel.coverage].some(
            (coverage) => !Number.isFinite(coverage) || coverage < 0,
          )) {
        throw new InvalidRobustCombineInput(
          'Per-frame drizzle values must be finite and coverage must be finite and non-negative.',
        );
      }
    }
  }

  const combinedChannels = [];
  for (let c = 0; c < channelCount; c++) {
    const value = new Float64Array(pixelCount);
    const coverage = new Float64Array(pixelCount);
    combinedChannels.push({ value, coverage });
  }

  const frameValueBuffer = new Float64Array(perFrameResults.length);
  const frameCoverageBuffer = new Float64Array(perFrameResults.length);

  for (let c = 0; c < channelCount; c++) {
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      let contributing = 0;
      for (let f = 0; f < perFrameResults.length; f++) {
        const frameCoverage = perFrameResults[f].channels[c].coverage[pixel];
        if (frameCoverage > minCoverage) {
          frameValueBuffer[contributing] =
            perFrameResults[f].channels[c].value[pixel];
          frameCoverageBuffer[contributing] = frameCoverage;
          contributing++;
        }
      }
      if (contributing === 0) continue;

      let survivorIndices;
      if (contributing < minFramesForRejection) {
        survivorIndices = Array.from({ length: contributing }, (_, i) => i);
      } else {
        const contributingValues = frameValueBuffer.slice(0, contributing);
        const center = median(contributingValues);
        const absoluteDeviations = Float64Array.from(
          contributingValues,
          (v) => Math.abs(v - center),
        );
        const mad = median(absoluteDeviations);
        const sigma = mad * MAD_TO_SIGMA;
        if (!Number.isFinite(center) ||
            !Number.isFinite(mad) ||
            !Number.isFinite(sigma)) {
          throw new InvalidRobustCombineInput(
            'Robust CFA combine produced a non-finite center or spread.',
          );
        }
        survivorIndices = [];
        for (let i = 0; i < contributing; i++) {
          const deviation = frameValueBuffer[i] - center;
          // sigma が 0 の場合でも、多数一致から明確に外れる単発異常値は
          // 棄却する。中心値と数値的に同一のサンプルだけを残す。
          if (sigma === 0) {
            // Zero MAD means a majority agrees with the median.  Reject
            // clear deviations instead of keeping an isolated cosmic-ray
            // or hot-pixel hit merely because the robust spread is zero.
            const equalityTolerance = 1e-12 * Math.max(1, Math.abs(center));
            if (Math.abs(deviation) <= equalityTolerance) {
              survivorIndices.push(i);
            }
            continue;
          }
          if (deviation > 0 && deviation > sigmaHigh * sigma) continue;
          if (deviation < 0 && -deviation > sigmaLow * sigma) continue;
          survivorIndices.push(i);
        }
        if (survivorIndices.length === 0) {
          // 理論上ほぼ起こらないはずだが(中央値自身は常に許容範囲内の
          // はず)、安全側として全棄却は許さず、少なくとも中央値に最も
          // 近い1フレームは残す。
          let closest = 0;
          let closestDeviation = Math.abs(frameValueBuffer[0] - center);
          for (let i = 1; i < contributing; i++) {
            const d = Math.abs(frameValueBuffer[i] - center);
            if (d < closestDeviation) {
              closest = i;
              closestDeviation = d;
            }
          }
          survivorIndices = [closest];
        }
      }

      let weightedValueSum = 0;
      let weightSum = 0;
      for (const index of survivorIndices) {
        weightedValueSum += frameValueBuffer[index]
          * frameCoverageBuffer[index];
        weightSum += frameCoverageBuffer[index];
      }
      const combinedValue = weightSum > 0
        ? weightedValueSum / weightSum
        : 0;
      if (!Number.isFinite(weightedValueSum) ||
          !Number.isFinite(weightSum) ||
          !Number.isFinite(combinedValue)) {
        throw new InvalidRobustCombineInput(
          'Robust CFA combine produced a non-finite output.',
        );
      }
      combinedChannels[c].value[pixel] = combinedValue;
      combinedChannels[c].coverage[pixel] = weightSum;
    }
  }

  return { width, height, channels: combinedChannels };
}
