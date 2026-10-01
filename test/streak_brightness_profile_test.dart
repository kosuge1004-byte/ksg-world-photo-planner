import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/meteor/streak_brightness_profile.dart';
import 'package:mobile_stack/core/meteor/streak_shape.dart';

/// Dart port of
/// `tool/raw_samples/test/streak_brightness_profile_reference.test.mjs`.

final class _Plane implements StreakBrightnessSource {
  _Plane(this.width, this.height, this.samples);

  @override
  final int width;
  @override
  final int height;
  @override
  final Float32List samples;
}

_Plane _makeBlankPlane(int width, int height, [double backgroundValue = 0.1]) {
  final Float32List samples = Float32List(width * height)
    ..fillRange(0, width * height, backgroundValue);
  return _Plane(width, height, samples);
}

/// Renders a continuous streak (smooth brightness along its full
/// length), matching the technique already validated in the star and
/// streak detector tests.
void _addContinuousStreak(
  _Plane plane,
  double x0,
  double y0,
  double x1,
  double y1,
  double peakAmplitude,
  double crossSigma, [
  double stepPx = 0.35,
]) {
  final double length = math.sqrt(
    math.pow(x1 - x0, 2) + math.pow(y1 - y0, 2),
  );
  final int steps = math.max(1, (length / stepPx).round());
  final int radius = (3 * crossSigma).ceil();
  for (int i = 0; i <= steps; i++) {
    final double t = i / steps;
    final double cx = x0 + (x1 - x0) * t;
    final double cy = y0 + (y1 - y0) * t;
    for (int dy = -radius; dy <= radius; dy++) {
      for (int dx = -radius; dx <= radius; dx++) {
        final int x = cx.round() + dx;
        final int y = cy.round() + dy;
        if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) {
          continue;
        }
        final double ox = x - cx;
        final double oy = y - cy;
        final double value = peakAmplitude *
            math.exp(-(ox * ox + oy * oy) / (2 * crossSigma * crossSigma)) *
            (stepPx / crossSigma);
        plane.samples[y * plane.width + x] += value;
      }
    }
  }
}

/// Renders a beaded (blinking-light) streak: several short bright
/// segments along the line, separated by gaps that drop back to
/// background -- the aircraft-navigation-light pattern.
void _addBeadedStreak(
  _Plane plane,
  double x0,
  double y0,
  double x1,
  double y1,
  double peakAmplitude,
  double crossSigma,
  int beadCount,
  double beadFraction,
) {
  for (int bead = 0; bead < beadCount; bead++) {
    final double segmentStart = bead / beadCount;
    final double segmentEnd = segmentStart + (beadFraction / beadCount);
    final double bx0 = x0 + (x1 - x0) * segmentStart;
    final double by0 = y0 + (y1 - y0) * segmentStart;
    final double bx1 = x0 + (x1 - x0) * segmentEnd;
    final double by1 = y0 + (y1 - y0) * segmentEnd;
    _addContinuousStreak(plane, bx0, by0, bx1, by1, peakAmplitude, crossSigma);
  }
}

final class _Streak implements StreakShape {
  _Streak(double x0, double y0, double x1, double y1, [double streakWidth = 3])
      : endpoints = <({double x, double y})>[(x: x0, y: y0), (x: x1, y: y1)],
        width = streakWidth;

  @override
  final List<({double x, double y})> endpoints;
  @override
  final double width;
}

void main() {
  test('rejects malformed source dimensions', () {
    expect(
      () => analyzeStreakBrightnessProfile(
        _Plane(0, 10, Float32List(0)),
        _Streak(0, 0, 5, 5),
      ),
      throwsA(isA<InvalidBrightnessProfileInput>()),
    );
  });

  test('precomputed background is equivalent and rejects invalid values', () {
    final _Plane plane = _makeBlankPlane(120, 60, 0.1);
    _addContinuousStreak(plane, 10, 30, 110, 30, 4.0, 1.3);
    final _Streak streak = _Streak(10, 30, 110, 30, 3);
    final StreakBrightnessProfile direct =
        analyzeStreakBrightnessProfile(plane, streak);
    final double background = estimateStreakBrightnessBackgroundMedian(plane);
    final StreakBrightnessProfile cached = analyzeStreakBrightnessProfile(
      plane,
      streak,
      backgroundMedian: background,
    );

    expect(cached.profile, direct.profile);
    expect(cached.segmentCount, direct.segmentCount);
    expect(cached.likelyBlinking, direct.likelyBlinking);
    expect(
      () => analyzeStreakBrightnessProfile(
        plane,
        streak,
        backgroundMedian: double.nan,
      ),
      throwsA(isA<InvalidBrightnessProfileInput>()),
    );
  });

  test('a smooth continuous streak shows exactly one segment (not blinking)',
      () {
    final _Plane plane = _makeBlankPlane(120, 60, 0.1);
    _addContinuousStreak(plane, 10, 30, 110, 30, 4.0, 1.3);
    final _Streak streak = _Streak(10, 30, 110, 30, 3);
    final StreakBrightnessProfile result =
        analyzeStreakBrightnessProfile(plane, streak);
    expect(result.segmentCount, 1);
    expect(result.likelyBlinking, false);
    expect(result.longestGapFraction, 0);
    expect(result.sufficientSamples, isTrue);
    final BrightnessSegment segment = result.segments.single;
    expect(segment.startFraction, lessThan(0.1));
    expect(segment.endFraction, greaterThan(0.9));
  });

  test(
    'a beaded (blinking-light) streak shows multiple segments '
    '(the aircraft navigation-light pattern)',
    () {
      final _Plane plane = _makeBlankPlane(200, 60, 0.1);
      // Five short bright beads spread evenly, each covering 30% of its
      // own 1/5 segment of the line, i.e. clearly separated gaps.
      _addBeadedStreak(plane, 10, 30, 190, 30, 5.0, 1.3, 5, 0.3);
      final _Streak streak = _Streak(10, 30, 190, 30, 3);
      final StreakBrightnessProfile result =
          analyzeStreakBrightnessProfile(plane, streak);
      expect(result.segmentCount, 5);
      expect(result.likelyBlinking, true);
      expect(result.longestGapFraction, greaterThan(0.05));
    },
  );

  test('a two-bead streak is still detected as blinking (the minimum case)',
      () {
    final _Plane plane = _makeBlankPlane(160, 60, 0.1);
    _addBeadedStreak(plane, 10, 30, 150, 30, 5.0, 1.3, 2, 0.35);
    final _Streak streak = _Streak(10, 30, 150, 30, 3);
    final StreakBrightnessProfile result =
        analyzeStreakBrightnessProfile(plane, streak);
    expect(result.segmentCount, 2);
    expect(result.likelyBlinking, true);
  });

  test('a fading (bolide-style) meteor-like streak is not blinking', () {
    // A streak that's brightest at one end and smoothly fades toward
    // the other, still fully continuous (never drops to background in
    // the middle) -- the classic meteor brightness pattern, and must
    // not be mistaken for blinking just because the brightness varies.
    final _Plane plane = _makeBlankPlane(120, 60, 0.1);
    const double x0 = 10;
    const double y0 = 30;
    const double x1 = 110;
    const double y1 = 30;
    const int steps = 200;
    for (int i = 0; i <= steps; i++) {
      final double t = i / steps;
      final double cx = x0 + (x1 - x0) * t;
      final double cy = y0 + (y1 - y0) * t;
      final double amplitude = 6.0 * (1 - 0.85 * t); // fades from 6.0 to 0.9
      for (int dy = -4; dy <= 4; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          final int x = cx.round() + dx;
          final int y = cy.round() + dy;
          if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) {
            continue;
          }
          final double value = amplitude *
              math.exp(-(dy * dy) / (2 * 1.3 * 1.3)) *
              (1 / steps) *
              40;
          plane.samples[y * plane.width + x] += value;
        }
      }
    }
    final _Streak streak = _Streak(10, 30, 110, 30, 3);
    final StreakBrightnessProfile result = analyzeStreakBrightnessProfile(
      plane,
      streak,
      relativeOnThreshold: 0.1, // the faded tail is much dimmer than the head
    );
    expect(result.segmentCount, 1);
    expect(result.likelyBlinking, false);
  });

  test(
    'a very short streak reports insufficient samples, not a spurious '
    'result',
    () {
      final _Plane plane = _makeBlankPlane(30, 30, 0.1);
      _addContinuousStreak(plane, 14, 15, 16, 15, 3.0, 1.0);
      final _Streak streak = _Streak(14, 15, 16, 15, 2);
      final StreakBrightnessProfile result = analyzeStreakBrightnessProfile(
        plane,
        streak,
        stepPx: 1,
      );
      expect(result.sufficientSamples, false);
      expect(result.likelyBlinking, false);
    },
  );

  test('a uniform (no-signal) plane produces no segments', () {
    final _Plane plane = _makeBlankPlane(100, 40, 0.2);
    final _Streak streak = _Streak(10, 20, 90, 20, 3);
    final StreakBrightnessProfile result =
        analyzeStreakBrightnessProfile(plane, streak);
    expect(result.segmentCount, 0);
    expect(result.likelyBlinking, false);
  });

  test(
    'a small dip within an otherwise continuous streak is not treated as '
    'a real gap (minGapPixels absorbs noise-level dips)',
    () {
      final _Plane plane = _makeBlankPlane(120, 60, 0.1);
      _addContinuousStreak(plane, 10, 30, 110, 30, 4.0, 1.3);
      // Carve a single-pixel-wide dip roughly in the middle, shallow
      // enough to stay above the relative "off" threshold given a
      // generous minGapPixels, simulating minor noise rather than a
      // true navigation-light gap.
      const int dipX = 60;
      for (int dy = -2; dy <= 2; dy++) {
        final int y = 30 + dy;
        plane.samples[y * plane.width + dipX] *= 0.85;
      }
      final _Streak streak = _Streak(10, 30, 110, 30, 3);
      final StreakBrightnessProfile result = analyzeStreakBrightnessProfile(
        plane,
        streak,
        minGapPixels: 4,
      );
      expect(result.segmentCount, 1);
      expect(result.likelyBlinking, false);
    },
  );

  test(
    'endpoints, positions, and profile arrays stay consistent in length',
    () {
      final _Plane plane = _makeBlankPlane(100, 40, 0.1);
      _addContinuousStreak(plane, 10, 20, 90, 20, 3.0, 1.2);
      final _Streak streak = _Streak(10, 20, 90, 20, 3);
      final StreakBrightnessProfile result = analyzeStreakBrightnessProfile(
        plane,
        streak,
        stepPx: 1,
      );
      expect(result.profile.length, result.positions.length);
      expect(result.profile.length, greaterThan(50));
      // Positions should trace from endpoint 0 toward endpoint 1.
      expect((result.positions.first.x - 10).abs(), lessThan(1.5));
      expect((result.positions.last.x - 90).abs(), lessThan(1.5));
    },
  );
}
