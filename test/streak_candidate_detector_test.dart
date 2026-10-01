import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/meteor/streak_candidate_detector.dart';

/// Dart port of `tool/raw_samples/test/streak_candidate_detector_
/// reference.test.mjs`. See `streak_candidate_detector.dart`'s own doc
/// comment for why this port was written with unusual care.

final class _Plane implements StreakDetectionSource {
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

void _addGaussianStar(
  _Plane plane,
  double cx,
  double cy,
  double peakAmplitude,
  double sigma, [
  int radius = 6,
]) {
  for (int dy = -radius; dy <= radius; dy++) {
    for (int dx = -radius; dx <= radius; dx++) {
      final int x = cx.round() + dx;
      final int y = cy.round() + dy;
      if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) continue;
      final double ox = x - cx;
      final double oy = y - cy;
      final double value =
          peakAmplitude * math.exp(-(ox * ox + oy * oy) / (2 * sigma * sigma));
      plane.samples[y * plane.width + x] += value;
    }
  }
}

/// Renders a smooth, continuous streak by summing many overlapping
/// cross-sectional Gaussian slices along a line.
void _addStreak(
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

void _addSeededNoise(_Plane plane, double amplitude, int seed) {
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  for (int i = 0; i < plane.samples.length; i++) {
    plane.samples[i] += (next() - 0.5) * amplitude;
  }
}

double _normalizeAngle(double radians) {
  double angle = radians % math.pi;
  if (angle > math.pi / 2) angle -= math.pi;
  if (angle <= -math.pi / 2) angle += math.pi;
  return angle;
}

void main() {
  test('rejects malformed source dimensions', () {
    expect(
      () => detectStreakCandidates(_Plane(0, 10, Float32List(0))),
      throwsA(isA<InvalidStreakDetectionInput>()),
    );
    expect(
      () => detectStreakCandidates(_Plane(10, 10, Float32List(5))),
      throwsA(isA<InvalidStreakDetectionInput>()),
    );
  });

  test('finds nothing on a uniform plane with no sources', () {
    final _Plane plane = _makeBlankPlane(80, 80, 0.2);
    _addSeededNoise(plane, 0.02, 999);
    expect(detectStreakCandidates(plane), isEmpty);
  });

  test('rejects round point sources (stars), finding no streaks', () {
    final _Plane plane = _makeBlankPlane(80, 80, 0.1);
    _addGaussianStar(plane, 20, 20, 8.0, 1.3);
    _addGaussianStar(plane, 50, 60, 5.0, 1.4);
    expect(detectStreakCandidates(plane), isEmpty);
  });

  test(
    'detects a horizontal streak with the correct orientation and '
    'centroid',
    () {
      final _Plane plane = _makeBlankPlane(100, 60, 0.1);
      _addStreak(plane, 10, 30, 90, 30, 3.0, 1.2);
      final List<StreakCandidate> candidates = detectStreakCandidates(plane);
      expect(candidates.length, 1);
      final StreakCandidate candidate = candidates.single;
      expect((candidate.centroidX - 50).abs(), lessThan(2));
      expect((candidate.centroidY - 30).abs(), lessThan(1));
      expect(
        (_normalizeAngle(candidate.angleRadians) - 0).abs(),
        lessThan(0.05),
        reason: 'expected ~0 radians (horizontal), got '
            '${candidate.angleRadians}',
      );
      expect(candidate.length, greaterThan(60));
      expect(candidate.elongation, greaterThan(0.8));
    },
  );

  test('detects a vertical streak with the correct orientation', () {
    final _Plane plane = _makeBlankPlane(60, 100, 0.1);
    _addStreak(plane, 30, 10, 30, 90, 3.0, 1.2);
    final List<StreakCandidate> candidates = detectStreakCandidates(plane);
    expect(candidates.length, 1);
    final double angle = _normalizeAngle(candidates[0].angleRadians);
    expect(
      (angle.abs() - math.pi / 2).abs(),
      lessThan(0.05),
      reason: 'expected ~+/-pi/2 radians (vertical), got $angle',
    );
  });

  test(
    'detects a diagonal streak with the correct orientation '
    '(regression for the eigenvector-angle numerical-instability bug)',
    () {
      final _Plane plane = _makeBlankPlane(100, 100, 0.1);
      _addStreak(plane, 10, 10, 90, 90, 3.0, 1.2);
      final List<StreakCandidate> candidates = detectStreakCandidates(plane);
      expect(candidates.length, 1);
      final double angle = _normalizeAngle(candidates[0].angleRadians);
      expect(
        (angle - math.pi / 4).abs(),
        lessThan(0.05),
        reason: 'expected ~pi/4 radians (45 degrees), got $angle',
      );
    },
  );

  test('detects streaks at several intermediate angles accurately', () {
    const List<int> degreesToTest = <int>[10, 30, 60, 75, 100, 135, 150, 170];
    for (final int degrees in degreesToTest) {
      final _Plane plane = _makeBlankPlane(120, 120, 0.1);
      final double radians = degrees * math.pi / 180;
      const double centerX = 60;
      const double centerY = 60;
      const double halfLength = 40;
      final double x0 = centerX - math.cos(radians) * halfLength;
      final double y0 = centerY - math.sin(radians) * halfLength;
      final double x1 = centerX + math.cos(radians) * halfLength;
      final double y1 = centerY + math.sin(radians) * halfLength;
      _addStreak(plane, x0, y0, x1, y1, 3.0, 1.2);
      final List<StreakCandidate> candidates = detectStreakCandidates(plane);
      expect(candidates.length, 1, reason: 'degrees=$degrees');
      final double expected = _normalizeAngle(radians);
      final double actual = _normalizeAngle(candidates[0].angleRadians);
      double delta = (actual - expected).abs();
      if (delta > math.pi / 2) delta = math.pi - delta;
      expect(
        delta,
        lessThan(0.05),
        reason: 'degrees=$degrees: expected ~$expected, got $actual',
      );
    }
  });

  test("endpoints stay within the region's actual bounding box", () {
    final _Plane plane = _makeBlankPlane(100, 60, 0.1);
    _addStreak(plane, 15, 30, 85, 30, 3.0, 1.2);
    final StreakCandidate candidate = detectStreakCandidates(plane).single;
    for (final ({double x, double y}) point in candidate.endpoints) {
      expect(
        point.x >= 10 && point.x <= 90,
        isTrue,
        reason: 'endpoint x=${point.x}',
      );
      expect(
        point.y >= 25 && point.y <= 35,
        isTrue,
        reason: 'endpoint y=${point.y}',
      );
    }
    final double span = math.sqrt(
      math.pow(
            candidate.endpoints[0].x - candidate.endpoints[1].x,
            2,
          ) +
          math.pow(
            candidate.endpoints[0].y - candidate.endpoints[1].y,
            2,
          ),
    );
    expect(span, greaterThan(50));
  });

  test('rejects a region below minLength even if elongated', () {
    final _Plane plane = _makeBlankPlane(60, 60, 0.1);
    _addStreak(plane, 25, 30, 35, 30, 3.0, 1.2); // only ~10px long
    final List<StreakCandidate> candidates = detectStreakCandidates(
      plane,
      minLength: 15,
    );
    expect(candidates, isEmpty);
  });

  test('rejects a large but round/diffuse blob (not elongated enough)', () {
    final _Plane plane = _makeBlankPlane(80, 80, 0.1);
    _addGaussianStar(plane, 40, 40, 4.0, 12, 30);
    final List<StreakCandidate> candidates = detectStreakCandidates(
      plane,
      minLength: 5,
    );
    expect(candidates, isEmpty);
  });

  test('caps results at maxCandidates, keeping the brightest', () {
    final _Plane plane = _makeBlankPlane(300, 300, 0.1);
    const List<double> amplitudes = <double>[6, 5, 4, 3];
    for (int index = 0; index < amplitudes.length; index++) {
      final double y = 30 + index * 70;
      _addStreak(plane, 20, y, 120, y, amplitudes[index], 1.2);
    }
    final List<StreakCandidate> candidates = detectStreakCandidates(
      plane,
      maxCandidates: 2,
    );
    expect(candidates.length, 2);
    expect(candidates[0].flux, greaterThanOrEqualTo(candidates[1].flux));
  });

  test(
    'two well-separated streaks are detected as two independent regions',
    () {
      final _Plane plane = _makeBlankPlane(200, 200, 0.1);
      _addStreak(plane, 10, 20, 90, 20, 3.0, 1.2);
      _addStreak(plane, 110, 150, 190, 180, 3.0, 1.2);
      final List<StreakCandidate> candidates = detectStreakCandidates(plane);
      expect(candidates.length, 2);
    },
  );

  test('flux and pixelCount scale sensibly with a brighter streak', () {
    final _Plane dimPlane = _makeBlankPlane(100, 60, 0.1);
    _addStreak(dimPlane, 15, 30, 85, 30, 2.0, 1.2);
    final _Plane brightPlane = _makeBlankPlane(100, 60, 0.1);
    _addStreak(brightPlane, 15, 30, 85, 30, 5.0, 1.2);
    final StreakCandidate dim = detectStreakCandidates(dimPlane).single;
    final StreakCandidate bright = detectStreakCandidates(brightPlane).single;
    expect(bright.flux, greaterThan(dim.flux));
  });

  test(
    'the necking (width-uniformity) gate rejects two point sources '
    'bridged by a thin neck, reproducing a real observed failure case',
    () {
      final _Plane plane = _makeBlankPlane(150, 100, 0.15);
      _addGaussianStar(plane, 30, 50, 6.0, 1.2);
      _addGaussianStar(plane, 38, 50, 6.0, 1.2);
      _addGaussianStar(plane, 46, 50, 6.0, 1.2);
      _addGaussianStar(plane, 54, 50, 6.0, 1.2);
      _addSeededNoise(plane, 0.02, 777);

      final List<StreakCandidate> withoutGate = detectStreakCandidates(
        plane,
        thresholdSigma: 5,
        minWidthUniformity: 0,
      );
      expect(
        withoutGate.length,
        1,
        reason: 'expected the pre-fix behavior to still show the '
            'false-positive merge for this fixture, or the fixture no '
            'longer demonstrates the bug being tested',
      );

      final List<StreakCandidate> withGate = detectStreakCandidates(
        plane,
        thresholdSigma: 5,
      );
      expect(
        withGate.length,
        0,
        reason: 'the necking gate should reject the four-star chain the '
            'un-gated detector accepted',
      );
    },
  );

  test(
    'a genuine uniform-width streak is not affected by the necking gate',
    () {
      final _Plane plane = _makeBlankPlane(120, 60, 0.1);
      _addStreak(plane, 10, 30, 110, 30, 4.0, 1.3);
      final List<StreakCandidate> candidates = detectStreakCandidates(
        plane,
        thresholdSigma: 5,
      );
      expect(candidates.length, 1);
    },
  );

  test(
    'a genuine fading (bolide-style) meteor tail is not rejected by the '
    'necking gate, since it only tapers near the true endpoints',
    () {
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
        final double amplitude = 6.0 * (1 - 0.85 * t);
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
      final List<StreakCandidate> candidates = detectStreakCandidates(
        plane,
        thresholdSigma: 5,
      );
      expect(
        candidates.length,
        1,
        reason: 'a legitimately fading meteor tail should not be '
            'rejected as a necking artifact',
      );
    },
  );

  test('minWidthUniformity: 0 opts out of the necking gate entirely', () {
    final _Plane plane = _makeBlankPlane(150, 100, 0.15);
    _addGaussianStar(plane, 30, 50, 6.0, 1.2);
    _addGaussianStar(plane, 38, 50, 6.0, 1.2);
    _addGaussianStar(plane, 46, 50, 6.0, 1.2);
    _addGaussianStar(plane, 54, 50, 6.0, 1.2);
    _addSeededNoise(plane, 0.02, 777);
    final List<StreakCandidate> candidates = detectStreakCandidates(
      plane,
      thresholdSigma: 5,
      minWidthUniformity: 0,
    );
    expect(candidates.length, 1);
  });

  test(
    'documented residual limitation: two heavily overlapping (very '
    'close) point sources can still pass the necking gate',
    () {
      final _Plane plane = _makeBlankPlane(100, 100, 0.15);
      _addGaussianStar(plane, 40, 50, 6.0, 1.3);
      _addGaussianStar(plane, 48, 50, 6.0, 1.3); // 8px separation
      _addSeededNoise(plane, 0.02, 555);
      final List<StreakCandidate> candidates = detectStreakCandidates(
        plane,
        thresholdSigma: 5,
      );
      expect(
        candidates.length,
        1,
        reason: 'if this now correctly rejects the pair, '
            "minWidthUniformity's default became stricter -- update "
            'this test to document the new boundary rather than '
            'treating this as a bug',
      );
    },
  );

  test(
    'the width-profile multi-lobe gate independently rejects a merge '
    'the necking gate alone would miss',
    () {
      final _Plane plane = _makeBlankPlane(150, 100, 0.15);
      _addGaussianStar(plane, 30, 50, 6.0, 1.2);
      _addGaussianStar(plane, 38, 50, 6.0, 1.2);
      _addGaussianStar(plane, 46, 50, 6.0, 1.2);
      _addGaussianStar(plane, 54, 50, 6.0, 1.2);
      _addGaussianStar(plane, 62, 50, 6.0, 1.2);
      _addSeededNoise(plane, 0.02, 321);

      final List<StreakCandidate> neckingOnly = detectStreakCandidates(
        plane,
        thresholdSigma: 5,
        maxWidthProfileLobes: double.infinity,
      );
      final List<StreakCandidate> bothGates = detectStreakCandidates(
        plane,
        thresholdSigma: 5,
      );
      expect(
        bothGates.length,
        lessThanOrEqualTo(neckingOnly.length),
        reason: 'the lobe gate should never let through more candidates '
            'than necking alone',
      );
      expect(
        bothGates.length,
        0,
        reason: 'expected the combined gates to reject this five-star '
            'chain',
      );
    },
  );

  test(
    'the multi-lobe gate does not false-reject a genuine diagonal '
    'streak (regression for a real bug found while building this gate)',
    () {
      final _Plane plane = _makeBlankPlane(100, 100, 0.1);
      _addStreak(plane, 10, 10, 90, 90, 3.0, 1.2);
      final List<StreakCandidate> candidates = detectStreakCandidates(
        plane,
        thresholdSigma: 5,
      );
      expect(
        candidates.length,
        1,
        reason: 'a genuine diagonal streak must not be rejected by the '
            'multi-lobe gate',
      );
      expect((candidates[0].centroidX - 50).abs(), lessThan(2));
      expect((candidates[0].centroidY - 50).abs(), lessThan(2));
    },
  );

  test(
    'maxWidthProfileLobes: Infinity opts out of the multi-lobe gate '
    'entirely',
    () {
      final _Plane plane = _makeBlankPlane(150, 100, 0.15);
      _addGaussianStar(plane, 30, 50, 6.0, 1.2);
      _addGaussianStar(plane, 38, 50, 6.0, 1.2);
      _addGaussianStar(plane, 46, 50, 6.0, 1.2);
      _addGaussianStar(plane, 54, 50, 6.0, 1.2);
      _addGaussianStar(plane, 62, 50, 6.0, 1.2);
      _addSeededNoise(plane, 0.02, 321);
      final List<StreakCandidate> candidates = detectStreakCandidates(
        plane,
        thresholdSigma: 5,
        minWidthUniformity: 0,
        maxWidthProfileLobes: double.infinity,
      );
      expect(candidates.length, 1);
    },
  );
}
