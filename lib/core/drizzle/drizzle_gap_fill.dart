import 'dart:typed_data';

import '../drizzle/drizzle_accumulator.dart' show DrizzleResult;
import 'cfa_drizzle.dart' show CfaDrizzleResult;

/// Dart port of `tool/raw_samples/drizzle_gap_fill_reference.mjs`.
///
/// `cfaDrizzle`'s own output is, by design, sparse per channel: at any
/// position where a channel's accumulated coverage is zero, that
/// channel simply has no real data there yet (see [DrizzleResult]'s own
/// producing `DrizzleAccumulator.finalize` doc comment — its `value` is
/// already a coverage-weighted average wherever coverage is positive,
/// and exactly `0` wherever it is not). A regular Bayer-pattern demosaic
/// algorithm is not the right tool to finish this: it assumes a fixed,
/// regular sampling pattern (exactly one known channel per pixel),
/// which drizzled output does not have.
///
/// This module fills each channel's own gaps independently (a missing
/// red sample is never filled using green or blue data) via a coverage-
/// weighted local average — see the Node reference's own doc comment for
/// the full rationale, including why this simple, easy-to-verify
/// approach was chosen over a more elaborate gradient-aware scheme.
///
/// Unlike the Node reference (which validates `kernelRadius` is an
/// integer), this Dart port has no such check: [kernelRadius] is itself
/// typed `int`, so the Node reference's "must be an integer" validation
/// branch is unreachable here — the type system already guarantees it,
/// the same "Node-level validation made unreachable by Dart's own type
/// system" situation this project's other ports have documented before.
///
/// This file has not been executed against the Dart SDK. It is a
/// careful line-by-line translation of the Node reference, which has
/// full test coverage. Run `test/drizzle_gap_fill_test.dart` before
/// relying on this in production.

class InvalidGapFillInput extends ArgumentError {
  InvalidGapFillInput(String super.message);
}

void _validateChannel(
  DrizzleResult channel,
  int width,
  int height,
  String label,
) {
  if (width <= 0 ||
      height <= 0 ||
      channel.value.length != width * height ||
      channel.coverage.length != width * height) {
    throw InvalidGapFillInput(
      '$label channel dimensions do not match width/height.',
    );
  }
  if (channel.value.any((double v) => !v.isFinite) ||
      channel.coverage.any((double c) => !c.isFinite || c < 0)) {
    throw InvalidGapFillInput(
      '$label channel must contain finite values and finite non-negative coverage.',
    );
  }
}

/// Fills the gaps in one channel's [DrizzleResult] independently of
/// every other channel.
///
/// Returns a new [DrizzleResult] of the same shape: a position whose own
/// coverage is `>= minimumCoverage` is passed through completely
/// unchanged (both value and coverage); a position below that threshold
/// is replaced by the coverage-weighted average of whichever neighbors
/// within [kernelRadius] (Chebyshev distance — a square neighborhood)
/// *do* meet the threshold. The synthesized position's output coverage
/// deliberately remains `0`: coverage in this API means direct source support,
/// not interpolation confidence. Keeping it at zero prevents a later stage
/// from mistaking a gap-filled value for a directly measured drizzle sample.
/// If no neighbor within range qualifies, value and coverage both remain `0`.
DrizzleResult fillChannelGaps(
  DrizzleResult channel,
  int width,
  int height, {
  int kernelRadius = 2,
  double minimumCoverage = 1e-6,
}) {
  _validateChannel(channel, width, height, 'input');
  if (kernelRadius < 1) {
    throw InvalidGapFillInput('kernelRadius must be a positive integer.');
  }
  if (!minimumCoverage.isFinite || minimumCoverage <= 0) {
    throw InvalidGapFillInput(
      'minimumCoverage must be finite and positive.',
    );
  }
  final Float64List value = channel.value;
  final Float64List coverage = channel.coverage;
  final Float64List filledValue = Float64List(width * height);
  final Float64List filledCoverage = Float64List(width * height);

  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      final int index = y * width + x;
      if (coverage[index] >= minimumCoverage) {
        filledValue[index] = value[index];
        filledCoverage[index] = coverage[index];
        continue;
      }
      double weightedValueSum = 0;
      double coverageSum = 0;
      final int minY = (y - kernelRadius).clamp(0, height - 1);
      final int maxY = (y + kernelRadius).clamp(0, height - 1);
      final int minX = (x - kernelRadius).clamp(0, width - 1);
      final int maxX = (x + kernelRadius).clamp(0, width - 1);
      for (int ny = minY; ny <= maxY; ny++) {
        for (int nx = minX; nx <= maxX; nx++) {
          final int neighborIndex = ny * width + nx;
          final double neighborCoverage = coverage[neighborIndex];
          if (neighborCoverage < minimumCoverage) continue;
          weightedValueSum += value[neighborIndex] * neighborCoverage;
          coverageSum += neighborCoverage;
        }
      }
      if (coverageSum > 0) {
        filledValue[index] = weightedValueSum / coverageSum;
        // Preserve source-support semantics: this value is synthesized from
        // neighboring samples, so its own direct coverage is still zero.
        // Callers that need interpolation confidence must track that as a
        // separate quantity rather than overloading source coverage.
        filledCoverage[index] = 0;
      }
      // else: stays 0/0, matching this module's own documented
      // "no qualifying neighbor -> leave as true zero, not extrapolated"
      // behavior.
    }
  }

  return DrizzleResult(
    width: width,
    height: height,
    value: filledValue,
    coverage: filledCoverage,
  );
}

/// Fills every channel of a [CfaDrizzleResult], independently via
/// [fillChannelGaps].
CfaDrizzleResult fillDrizzleResultGaps(
  CfaDrizzleResult result, {
  int kernelRadius = 2,
  double minimumCoverage = 1e-6,
}) {
  return CfaDrizzleResult(
    width: result.width,
    height: result.height,
    channels: <DrizzleResult>[
      for (final DrizzleResult channel in result.channels)
        fillChannelGaps(
          channel,
          result.width,
          result.height,
          kernelRadius: kernelRadius,
          minimumCoverage: minimumCoverage,
        ),
    ],
  );
}
