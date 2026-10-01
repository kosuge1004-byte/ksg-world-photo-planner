import 'dart:math' as math;

import 'streak_shape.dart';

/// Dart port of `tool/raw_samples/streak_brightness_profile_reference.
/// mjs`.
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
/// consistent with this project's meteor-mode design, the output is a
/// signal for the human review step or for combining with the other
/// signals, not a final verdict.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it); it is a careful line-by-line
/// translation of the Node reference, which has full test coverage. Run
/// `test/streak_brightness_profile_test.dart` (mirroring the Node
/// fixtures) before relying on this in production.

class InvalidBrightnessProfileInput extends ArgumentError {
  InvalidBrightnessProfileInput(super.message);
}

/// A single-channel intensity plane, matching `LuminancePlane`'s shape
/// (`{width, height, samples}`); a lightweight local alias so this
/// module doesn't need to import the registration feature's type for
/// what is otherwise an unrelated concern. Any `{width, height,
/// samples}`-shaped plane, including a real `LuminancePlane`, can be
/// passed via `StreakBrightnessSource.from`.
abstract interface class StreakBrightnessSource {
  int get width;
  int get height;
  List<double> get samples;
}

double _sampleAt(StreakBrightnessSource source, int x, int y) =>
    source.samples[y * source.width + x];

void _validateSource(StreakBrightnessSource source) {
  if (source.width <= 0 ||
      source.height <= 0 ||
      source.samples.length != source.width * source.height) {
    throw InvalidBrightnessProfileInput(
      'Invalid source dimensions or sample count.',
    );
  }
}

double _percentile(List<double> sortedValues, double fraction) {
  if (sortedValues.isEmpty) return 0;
  final int index = math.min(
    sortedValues.length - 1,
    math.max(0, (fraction * (sortedValues.length - 1)).round()),
  );
  return sortedValues[index];
}

/// Same robust median approach as the star and streak detectors
/// (deliberately duplicated, not shared — see the Node reference's
/// equivalent note). Only the median is needed here (for background
/// subtraction), not the full sigma estimate, since this module's
/// "on"/"off" threshold is adaptive per streak (a fraction of that
/// streak's own peak brightness) rather than a fixed noise-sigma
/// multiple.
double _estimateBackgroundMedian(
  StreakBrightnessSource source,
  int sampleStride,
) {
  final List<double> values = <double>[];
  for (int y = 0; y < source.height; y += sampleStride) {
    for (int x = 0; x < source.width; x += sampleStride) {
      values.add(_sampleAt(source, x, y));
    }
  }
  values.sort();
  return _percentile(values, 0.5);
}

/// Computes the whole-frame background estimate shared by every streak in
/// the same frame. Multi-streak callers should calculate this once and pass
/// it to [analyzeStreakBrightnessProfile].
double estimateStreakBrightnessBackgroundMedian(
  StreakBrightnessSource source, {
  int sampleStride = 4,
}) {
  _validateSource(source);
  return _estimateBackgroundMedian(source, math.max(1, sampleStride));
}

/// Samples the maximum background-subtracted intensity within a
/// perpendicular slice of half-width [slabHalfWidth] around
/// `(centerX, centerY)`, in the direction perpendicular to
/// `(dirX, dirY)` (a unit vector along the streak). Using the max over a
/// slice, not a single interpolated point, makes the profile robust to
/// the streak not being perfectly centered on the ideal straight line.
double _sampleSlabMax(
  StreakBrightnessSource source,
  double centerX,
  double centerY,
  double dirX,
  double dirY,
  double slabHalfWidth,
  double backgroundMedian,
) {
  final double perpX = -dirY;
  final double perpY = dirX;
  double maxValue = double.negativeInfinity;
  final int steps = math.max(1, (slabHalfWidth * 2).ceil());
  for (int step = 0; step <= steps; step++) {
    final double offset = -slabHalfWidth + (2 * slabHalfWidth * step) / steps;
    final int x = (centerX + perpX * offset).round();
    final int y = (centerY + perpY * offset).round();
    if (x < 0 || y < 0 || x >= source.width || y >= source.height) continue;
    final double value = _sampleAt(source, x, y) - backgroundMedian;
    if (value > maxValue) maxValue = value;
  }
  return maxValue == double.negativeInfinity ? 0 : math.max(0, maxValue);
}

final class _Run {
  _Run({required this.startIndex, required this.endIndex});

  final int startIndex;
  int endIndex;
}

/// Finds contiguous runs of `true` in [onFlags] at least [minRunLength]
/// samples long, merging runs separated by a `false` gap shorter than
/// [minGapLength] (treating a too-short dip as noise within one
/// continuous segment, not a real off-segment).
List<_Run> _findRuns(List<bool> onFlags, int minRunLength, int minGapLength) {
  final List<_Run> rawRuns = <_Run>[];
  int runStart = -1;
  for (int index = 0; index < onFlags.length; index++) {
    if (onFlags[index]) {
      if (runStart < 0) runStart = index;
    } else if (runStart >= 0) {
      rawRuns.add(_Run(startIndex: runStart, endIndex: index - 1));
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    rawRuns.add(_Run(startIndex: runStart, endIndex: onFlags.length - 1));
  }

  final List<_Run> merged = <_Run>[];
  for (final _Run run in rawRuns) {
    final _Run? previous = merged.isEmpty ? null : merged.last;
    if (previous != null &&
        run.startIndex - previous.endIndex - 1 < minGapLength) {
      previous.endIndex = run.endIndex;
    } else {
      merged.add(_Run(startIndex: run.startIndex, endIndex: run.endIndex));
    }
  }

  return merged
      .where((_Run run) => run.endIndex - run.startIndex + 1 >= minRunLength)
      .toList();
}

/// A detected bright segment along a streak's length, as a fraction
/// (`0` to `1`) of the sampled range.
final class BrightnessSegment {
  const BrightnessSegment({
    required this.startFraction,
    required this.endFraction,
  });

  final double startFraction;
  final double endFraction;
}

/// The result of [analyzeStreakBrightnessProfile].
///
/// - [profile]: the raw background-subtracted sample values, in order
///   from `endpoints[0]` to `endpoints[1]`.
/// - [positions]: each sample's location, same order.
/// - [segments]: detected bright-run ranges, sorted in sampling order.
/// - [segmentCount]: `segments.length`.
/// - [likelyBlinking]: `segmentCount >= 2` — multiple distinct bright
///   segments separated by real gaps, the aircraft-navigation-light
///   pattern. `false` for zero or one segment (a smooth, continuous
///   trail, or too little signal to say).
/// - [longestGapFraction]: the longest off-gap between two kept
///   segments, as a fraction of the streak's sampled length (`0` if
///   fewer than two segments).
/// - [sufficientSamples]: `false` if the streak was too short to sample
///   meaningfully (fewer than 4 profile samples); when `false`, treat
///   [likelyBlinking] as inconclusive rather than a real "no".
final class StreakBrightnessProfile {
  const StreakBrightnessProfile({
    required this.profile,
    required this.positions,
    required this.segments,
    required this.segmentCount,
    required this.likelyBlinking,
    required this.longestGapFraction,
    required this.sufficientSamples,
  });

  final List<double> profile;
  final List<({double x, double y})> positions;
  final List<BrightnessSegment> segments;
  final int segmentCount;
  final bool likelyBlinking;
  final double longestGapFraction;
  final bool sufficientSamples;
}

/// Analyzes the brightness profile of [streak] along its length within
/// [source] (the same plane `detectStreakCandidates` was run on).
///
/// - [stepPx] (default 0.5): spacing between profile samples along the
///   streak's length, in pixels.
/// - [slabHalfWidthPixels] (default `max(1.5, streak.width / 2 + 1)`):
///   half-width of the perpendicular search slice at each sample point.
/// - [relativeOnThreshold] (default 0.35): a sample counts as "on" if
///   its background-subtracted value is at least this fraction of the
///   profile's own peak background-subtracted value.
/// - [minOnRunPixels] (default 2): minimum contiguous "on" length, in
///   pixels along the streak, to count as a real bright segment rather
///   than noise.
/// - [minGapPixels] (default 2): minimum contiguous "off" length, in
///   pixels, to count as a real gap between segments rather than a
///   small dip within one continuous segment.
/// - [backgroundSampleStride] (default 4): subsampling stride for the
///   background median pass, used only when [backgroundMedian] is omitted.
/// - [backgroundMedian]: a precomputed whole-frame estimate. Supplying it
///   avoids repeating the same full-frame sort for every streak.
StreakBrightnessProfile analyzeStreakBrightnessProfile(
  StreakBrightnessSource source,
  StreakShape streak, {
  double stepPx = 0.5,
  double? slabHalfWidthPixels,
  double relativeOnThreshold = 0.35,
  double minOnRunPixels = 2,
  double minGapPixels = 2,
  int backgroundSampleStride = 4,
  double? backgroundMedian,
}) {
  _validateSource(source);
  if (backgroundMedian != null && !backgroundMedian.isFinite) {
    throw InvalidBrightnessProfileInput(
      'The precomputed background median must be finite.',
    );
  }
  final double effectiveSlabHalfWidthPixels =
      slabHalfWidthPixels ?? math.max(1.5, streak.width / 2 + 1);

  final ({double x, double y}) start = streak.endpoints[0];
  final ({double x, double y}) end = streak.endpoints[1];
  final double dx = end.x - start.x;
  final double dy = end.y - start.y;
  final double length = math.sqrt(dx * dx + dy * dy);
  final double dirX = length > 1e-9 ? dx / length : 1;
  final double dirY = length > 1e-9 ? dy / length : 0;

  final int sampleCount = math.max(1, (length / stepPx).round()) + 1;
  final double resolvedBackgroundMedian = backgroundMedian ??
      _estimateBackgroundMedian(
        source,
        math.max(1, backgroundSampleStride),
      );

  final List<double> profile = List<double>.filled(sampleCount, 0);
  final List<({double x, double y})> positions =
      List<({double x, double y})>.filled(sampleCount, (x: 0, y: 0));
  for (int index = 0; index < sampleCount; index++) {
    final double t = sampleCount == 1 ? 0 : index / (sampleCount - 1);
    final double x = start.x + dx * t;
    final double y = start.y + dy * t;
    positions[index] = (x: x, y: y);
    profile[index] = _sampleSlabMax(
      source,
      x,
      y,
      dirX,
      dirY,
      effectiveSlabHalfWidthPixels,
      resolvedBackgroundMedian,
    );
  }

  final bool sufficientSamples = sampleCount >= 4;
  double peakValue = 0;
  for (final double value in profile) {
    if (value > peakValue) peakValue = value;
  }
  final double onThreshold = peakValue * relativeOnThreshold;
  final List<bool> onFlags = profile
      .map((double value) => value >= onThreshold && peakValue > 0)
      .toList();

  final int minRunSamples = math.max(1, (minOnRunPixels / stepPx).round());
  final int minGapSamples = math.max(1, (minGapPixels / stepPx).round());
  final List<_Run> runs = _findRuns(onFlags, minRunSamples, minGapSamples);

  final List<BrightnessSegment> segments = runs
      .map(
        (_Run run) => BrightnessSegment(
          startFraction:
              sampleCount > 1 ? run.startIndex / (sampleCount - 1) : 0,
          endFraction: sampleCount > 1 ? run.endIndex / (sampleCount - 1) : 1,
        ),
      )
      .toList();

  double longestGapFraction = 0;
  for (int index = 1; index < runs.length; index++) {
    final int gapSamples =
        runs[index].startIndex - runs[index - 1].endIndex - 1;
    final double gapFraction =
        sampleCount > 1 ? gapSamples / (sampleCount - 1) : 0;
    if (gapFraction > longestGapFraction) longestGapFraction = gapFraction;
  }

  return StreakBrightnessProfile(
    profile: profile,
    positions: positions,
    segments: segments,
    segmentCount: segments.length,
    likelyBlinking: segments.length >= 2,
    longestGapFraction: longestGapFraction,
    sufficientSamples: sufficientSamples,
  );
}
