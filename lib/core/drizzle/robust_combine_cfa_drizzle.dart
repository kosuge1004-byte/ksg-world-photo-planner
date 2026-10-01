import 'dart:math' as math;
import 'dart:typed_data';

import 'cfa_drizzle.dart' show CfaDrizzleResult;
import 'drizzle_accumulator.dart' show DrizzleResult;

/// Dart port of `tool/raw_samples/robust_combine_cfa_drizzle_
/// reference.mjs`.
///
/// Addresses a real gap this project's CFA drizzle pipeline had: the
/// existing, already-tested `cfaDrizzle`/`DrizzleAccumulator`
/// (`cfa_drizzle.dart`, `drizzle_accumulator.dart`) blindly sums every
/// frame's weighted contribution into each output pixel, with no
/// rejection of any kind. A cosmic ray hit, a satellite or aircraft
/// trail crossing a single frame, a residual hot pixel, or any other
/// single-frame, single-position anomaly gets averaged straight into
/// the final stack, diluted but never actually removed.
///
/// This module does **not** modify the existing CFA drizzle core at
/// all — it combines *N separate, per-frame* drizzle results (each
/// produced by calling the existing, unmodified `cfaDrizzle`/
/// `drizzleCfaTiled` once per frame instead of once for all frames
/// together) via a robust statistic instead of a plain weighted sum.
///
/// See the Node reference's own doc comment for the full design
/// rationale, including:
/// - why fewer than [minFramesForRejection] contributing frames at a
///   position skips rejection entirely there (protecting real stars/
///   fine structure present in too few frames to distinguish
///   statistically from a genuine anomaly);
/// - why the robust center is the **median** (not the mean, which is
///   itself sensitive to the outliers being rejected) and the spread is
///   MAD-derived (median absolute deviation, scaled by 1.4826);
/// - why [sigmaLow]/[sigmaHigh] are separate, asymmetric thresholds
///   (astrophotography defects are usually anomalously *bright*, not
///   dim);
/// - why a genuine star present in a majority of frames survives (the
///   robust center naturally anchors to majority agreement, and MAD
///   rejection only excludes minority deviations).
///
/// This file has not been executed against the Dart SDK. It is a
/// careful line-by-line translation of the Node reference, which has
/// full test coverage. Run `test/robust_combine_cfa_drizzle_test.dart`
/// before relying on this in production.

class InvalidRobustCombineInput extends ArgumentError {
  InvalidRobustCombineInput(String super.message);
}

double _medianPrefix(Float64List values, int count) {
  final int middle = count >> 1;
  final double upper = _selectKth(values, count, middle);
  if (count.isOdd) return upper;
  // Quickselect guarantees every entry before [middle] is <= the selected
  // upper median. The greatest of that partition is therefore the lower
  // median, without a second sort or another per-pixel allocation.
  double lower = values[0];
  for (int index = 1; index < middle; index++) {
    if (values[index] > lower) lower = values[index];
  }
  return (lower + upper) / 2;
}

double _selectKth(Float64List values, int count, int kth) {
  int left = 0;
  int right = count - 1;
  while (left < right) {
    final int pivotIndex = left + ((right - left) >> 1);
    final double pivot = values[pivotIndex];
    int lower = left;
    int index = left;
    int upper = right;
    // Three-way partition is important for low-noise stacks: many identical
    // values (and especially a zero-MAD deviation buffer) stay O(N), rather
    // than degrading a two-way quickselect to O(N^2) per output sample.
    while (index <= upper) {
      final double value = values[index];
      if (value < pivot) {
        final double swap = values[lower];
        values[lower] = value;
        values[index] = swap;
        lower++;
        index++;
      } else if (value > pivot) {
        final double swap = values[upper];
        values[upper] = value;
        values[index] = swap;
        upper--;
      } else {
        index++;
      }
    }
    if (kth < lower) {
      right = lower - 1;
    } else if (kth > upper) {
      left = upper + 1;
    } else {
      return pivot;
    }
  }
  return values[left];
}

const double _madToSigma = 1.4826;

/// Combines [perFrameResults] (each a `cfaDrizzle`-shaped result for
/// one individual frame, all sharing the same width/height/channel
/// count) into a single combined [CfaDrizzleResult], applying robust,
/// per-pixel, per-channel outlier rejection across frames — see this
/// file's own doc comment for the full design.
///
/// - [minCoverage] (default `1e-6`): a frame's own value at a position
///   is only considered "contributing" there if its own coverage
///   exceeds this.
/// - [minFramesForRejection] (default `4`): fewer contributing frames
///   than this at a position skips rejection entirely for that
///   position.
/// - [sigmaLow]/[sigmaHigh] (defaults `4`/`3`): MAD-derived-sigma
///   rejection thresholds below/above the median.
///
/// Throws [InvalidRobustCombineInput] if [perFrameResults] is empty, if
/// any two entries have mismatched dimensions or channel count, or if
/// [minFramesForRejection] is less than `2`.
CfaDrizzleResult robustCombineCfaDrizzleResults(
  List<CfaDrizzleResult> perFrameResults, {
  double minCoverage = 1e-6,
  int minFramesForRejection = 4,
  double sigmaLow = 4,
  double sigmaHigh = 3,
}) {
  if (perFrameResults.isEmpty) {
    throw InvalidRobustCombineInput(
      'At least one per-frame drizzle result is required.',
    );
  }
  if (minFramesForRejection < 2) {
    throw InvalidRobustCombineInput(
      'minFramesForRejection must be an integer >= 2.',
    );
  }
  if (!minCoverage.isFinite || minCoverage < 0) {
    throw InvalidRobustCombineInput(
      'minCoverage must be finite and non-negative.',
    );
  }
  if (!sigmaLow.isFinite ||
      !sigmaHigh.isFinite ||
      sigmaLow <= 0 ||
      sigmaHigh <= 0) {
    throw InvalidRobustCombineInput(
      'sigmaLow and sigmaHigh must be finite and positive.',
    );
  }
  final CfaDrizzleResult first = perFrameResults[0];
  final int width = first.width;
  final int height = first.height;
  final int channelCount = first.channels.length;
  if (width <= 0 || height <= 0 || channelCount <= 0) {
    throw InvalidRobustCombineInput(
      'Per-frame drizzle dimensions and channel count must be positive.',
    );
  }
  final int pixelCount = width * height;
  for (final CfaDrizzleResult result in perFrameResults) {
    if (result.width != width || result.height != height) {
      throw InvalidRobustCombineInput(
        'All per-frame results must share the same dimensions.',
      );
    }
    if (result.channels.length != channelCount) {
      throw InvalidRobustCombineInput(
        'All per-frame results must have the same channel count.',
      );
    }
    for (final DrizzleResult channel in result.channels) {
      if (channel.value.length != pixelCount ||
          channel.coverage.length != pixelCount) {
        throw InvalidRobustCombineInput(
          'Per-frame drizzle channel lengths must match image dimensions.',
        );
      }
    }
  }

  final List<DrizzleResult> combinedChannels = <DrizzleResult>[
    for (int c = 0; c < channelCount; c++)
      DrizzleResult(
        width: width,
        height: height,
        value: Float64List(pixelCount),
        coverage: Float64List(pixelCount),
      ),
  ];

  final Float64List frameValueBuffer = Float64List(perFrameResults.length);
  final Float64List frameCoverageBuffer = Float64List(
    perFrameResults.length,
  );
  final Float64List selectionScratch = Float64List(perFrameResults.length);

  for (int c = 0; c < channelCount; c++) {
    for (int pixel = 0; pixel < pixelCount; pixel++) {
      int contributing = 0;
      for (int f = 0; f < perFrameResults.length; f++) {
        final double frameValue = perFrameResults[f].channels[c].value[pixel];
        final double frameCoverage =
            perFrameResults[f].channels[c].coverage[pixel];
        if (!frameValue.isFinite ||
            !frameCoverage.isFinite ||
            frameCoverage < 0) {
          throw InvalidRobustCombineInput(
            'Per-frame drizzle values must be finite and coverage must be finite and non-negative.',
          );
        }
        if (frameCoverage > minCoverage) {
          frameValueBuffer[contributing] = frameValue;
          frameCoverageBuffer[contributing] = frameCoverage;
          contributing++;
        }
      }
      if (contributing == 0) continue;

      double weightedValueSum = 0;
      double weightSum = 0;
      if (contributing < minFramesForRejection) {
        for (int index = 0; index < contributing; index++) {
          weightedValueSum +=
              frameValueBuffer[index] * frameCoverageBuffer[index];
          weightSum += frameCoverageBuffer[index];
        }
      } else {
        for (int index = 0; index < contributing; index++) {
          selectionScratch[index] = frameValueBuffer[index];
        }
        final double center = _medianPrefix(selectionScratch, contributing);
        for (int index = 0; index < contributing; index++) {
          selectionScratch[index] = (frameValueBuffer[index] - center).abs();
        }
        final double mad = _medianPrefix(selectionScratch, contributing);
        final double sigma = mad * _madToSigma;
        if (!center.isFinite || !mad.isFinite || !sigma.isFinite) {
          throw InvalidRobustCombineInput(
            'Robust CFA combine produced a non-finite center or spread.',
          );
        }
        for (int i = 0; i < contributing; i++) {
          final double deviation = frameValueBuffer[i] - center;
          bool survives = true;
          if (sigma == 0) {
            // A zero MAD means at least half of the contributing frames
            // agree exactly with the robust center.  Keeping every frame
            // here would also keep an isolated cosmic-ray/hot-pixel hit
            // such as [100, 100, 100, 5000], defeating robust rejection
            // in one of its cleanest cases.  Preserve only values that
            // are numerically indistinguishable from the center.
            final double equalityTolerance =
                1e-12 * math.max(1.0, center.abs());
            survives = deviation.abs() <= equalityTolerance;
          } else {
            if (deviation > 0 && deviation > sigmaHigh * sigma) {
              survives = false;
            }
            if (deviation < 0 && -deviation > sigmaLow * sigma) {
              survives = false;
            }
          }
          if (!survives) continue;
          weightedValueSum += frameValueBuffer[i] * frameCoverageBuffer[i];
          weightSum += frameCoverageBuffer[i];
        }
        if (weightSum == 0) {
          int closest = 0;
          double closestDeviation = (frameValueBuffer[0] - center).abs();
          for (int i = 1; i < contributing; i++) {
            final double d = (frameValueBuffer[i] - center).abs();
            if (d < closestDeviation) {
              closest = i;
              closestDeviation = d;
            }
          }
          weightedValueSum =
              frameValueBuffer[closest] * frameCoverageBuffer[closest];
          weightSum = frameCoverageBuffer[closest];
        }
      }
      final double combinedValue =
          weightSum > 0 ? weightedValueSum / weightSum : 0;
      if (!weightedValueSum.isFinite ||
          !weightSum.isFinite ||
          !combinedValue.isFinite) {
        throw InvalidRobustCombineInput(
          'Robust CFA combine produced a non-finite output.',
        );
      }
      combinedChannels[c].value[pixel] = combinedValue;
      combinedChannels[c].coverage[pixel] = weightSum;
    }
  }

  return CfaDrizzleResult(
    width: width,
    height: height,
    channels: combinedChannels,
  );
}
