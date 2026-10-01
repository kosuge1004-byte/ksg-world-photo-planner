import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/luminance_plane.dart';
import 'package:mobile_stack/core/registration/star_detector.dart';

/// Dart port of
/// `tool/raw_samples/test/star_centroid_detector_reference.test.mjs`.
/// Mirrors the Node fixtures so this test exercises the same scenarios
/// that were validated (and, for the roundness metric, debugged) against
/// the Node reference implementation.

LuminancePlane _makeBlankPlane(
  int width,
  int height, [
  double backgroundValue = 0.1,
]) {
  final Float32List samples = Float32List(width * height)
    ..fillRange(0, width * height, backgroundValue);
  return LuminancePlane(width: width, height: height, samples: samples);
}

void _addGaussianStar(
  LuminancePlane plane,
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

void _addSeededNoise(LuminancePlane plane, double amplitude, int seed) {
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  for (int i = 0; i < plane.samples.length; i++) {
    plane.samples[i] += (next() - 0.5) * amplitude;
  }
}

void _addHotPixel(LuminancePlane plane, int x, int y, double value) {
  plane.samples[y * plane.width + x] = value;
}

void _addSmearedTrail(
  LuminancePlane plane,
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

double _nearestDistance(List<DetectedStar> stars, double x, double y) =>
    stars.fold(
      double.infinity,
      (double best, DetectedStar star) => math.min(
        best,
        math.sqrt(math.pow(star.x - x, 2) + math.pow(star.y - y, 2)),
      ),
    );

void main() {
  test(
    'LuminancePlane rejects a mismatched sample count '
    '(so detectStars can never see malformed dimensions)',
    () {
      expect(
        () => LuminancePlane(width: 10, height: 10, samples: Float32List(5)),
        throwsArgumentError,
      );
    },
  );

  test('returns no stars for a plane smaller than the window', () {
    final LuminancePlane plane = _makeBlankPlane(4, 4);
    expect(detectStars(plane, windowRadius: 4), isEmpty);
  });

  test('finds a single bright Gaussian star near its true center', () {
    final LuminancePlane plane = _makeBlankPlane(64, 64, 0.1);
    _addGaussianStar(plane, 32.3, 28.7, 5.0, 1.4);
    final List<DetectedStar> stars = detectStars(plane, thresholdSigma: 5);
    expect(stars.length, 1);
    expect((stars[0].x - 32.3).abs(), lessThan(0.15));
    expect((stars[0].y - 28.7).abs(), lessThan(0.15));
  });

  test('finds multiple stars and ranks them by descending flux', () {
    final LuminancePlane plane = _makeBlankPlane(96, 96, 0.1);
    _addGaussianStar(plane, 20, 20, 8.0, 1.3); // brightest
    _addGaussianStar(plane, 70, 60, 4.0, 1.3); // dimmer
    _addGaussianStar(plane, 50, 15, 2.5, 1.1); // dimmest
    final List<DetectedStar> stars = detectStars(plane, thresholdSigma: 5);
    expect(stars.length, 3);
    expect(stars[0].flux, greaterThan(stars[1].flux));
    expect(stars[1].flux, greaterThan(stars[2].flux));
    expect(_nearestDistance(stars, 20, 20), lessThan(0.3));
    expect(_nearestDistance(stars, 70, 60), lessThan(0.3));
    expect(_nearestDistance(stars, 50, 15), lessThan(0.3));
  });

  test('stays close to true centroids under moderate photon-style noise', () {
    final LuminancePlane plane = _makeBlankPlane(80, 80, 0.2);
    const List<(double, double)> trueStars = <(double, double)>[
      (15.4, 12.6),
      (60.1, 55.9),
      (40.0, 70.2),
    ];
    for (final (double x, double y) in trueStars) {
      _addGaussianStar(plane, x, y, 6.0, 1.5);
    }
    _addSeededNoise(plane, 0.05, 12345);
    final List<DetectedStar> stars = detectStars(plane, thresholdSigma: 5);
    expect(stars.length, trueStars.length);
    for (final (double tx, double ty) in trueStars) {
      expect(
        _nearestDistance(stars, tx, ty),
        lessThan(0.3),
        reason: 'expected a match near ($tx, $ty)',
      );
    }
  });

  test('rejects an isolated single hot pixel via the sharpness gate', () {
    final LuminancePlane plane = _makeBlankPlane(48, 48, 0.1);
    _addGaussianStar(plane, 24, 24, 5.0, 1.4);
    _addHotPixel(plane, 10, 10, 50.0);
    final List<DetectedStar> stars = detectStars(plane, thresholdSigma: 5);
    expect(stars.length, 1);
    expect((stars[0].x - 24).abs(), lessThan(0.2));
    expect((stars[0].y - 24).abs(), lessThan(0.2));
  });

  test(
    'rejects an elongated satellite-style trail via the roundness gate',
    () {
      final LuminancePlane plane = _makeBlankPlane(64, 64, 0.1);
      _addGaussianStar(plane, 32, 32, 5.0, 1.4);
      // A diagonal streak, well clear of the star, that would look round
      // under a naive axis-aligned (x-variance vs y-variance) elongation
      // metric but is genuinely elongated once the covariance term is
      // accounted for.
      _addSmearedTrail(plane, 2, 2, 60, 20, 4.0, 1.2);
      final List<DetectedStar> stars = detectStars(plane, thresholdSigma: 5);
      expect(stars.length, 1);
      expect((stars[0].x - 32).abs(), lessThan(0.2));
      expect((stars[0].y - 32).abs(), lessThan(0.2));
    },
  );

  test('detects elongation along a diagonal, not just axis-aligned', () {
    // A source elongated at 45 degrees can have secondX == secondY (equal
    // axis-aligned variances) while still being highly elongated; only
    // the covariance (cross) term reveals it. This directly regresses
    // against an axis-aligned-only roundness formula, which would score
    // this as round.
    final LuminancePlane plane = _makeBlankPlane(64, 64, 0.1);
    _addSmearedTrail(plane, 12, 12, 52, 52, 5.0, 1.0);
    final List<DetectedStar> stars = detectStars(
      plane,
      thresholdSigma: 5,
      maxRoundness: 1, // accept everything so we can inspect the metric
      minSeparation: 20,
    );
    expect(stars, isNotEmpty);
    final DetectedStar mostElongated = stars.reduce(
      (DetectedStar best, DetectedStar star) =>
          star.roundness > best.roundness ? star : best,
    );
    expect(
      mostElongated.roundness,
      greaterThan(0.6),
      reason: 'expected high roundness for a diagonal trail, got '
          '${mostElongated.roundness}',
    );
  });

  test('enforces minimum separation between close peaks', () {
    final LuminancePlane plane = _makeBlankPlane(64, 64, 0.1);
    _addGaussianStar(plane, 30, 32, 5.0, 1.4);
    _addGaussianStar(plane, 32, 32, 5.0, 1.4);
    final List<DetectedStar> stars = detectStars(
      plane,
      thresholdSigma: 5,
      minSeparation: 8,
    );
    expect(stars.length, 1);
  });

  test('caps the result at maxStars, keeping the brightest', () {
    final LuminancePlane plane = _makeBlankPlane(200, 200, 0.1);
    const List<double> amplitudes = <double>[9, 8, 7, 6, 5, 4, 3];
    for (int index = 0; index < amplitudes.length; index++) {
      _addGaussianStar(
        plane,
        (20 + index * 25).toDouble(),
        (20 + index * 20).toDouble(),
        amplitudes[index],
        1.2,
      );
    }
    final List<DetectedStar> stars = detectStars(
      plane,
      thresholdSigma: 5,
      maxStars: 3,
    );
    expect(stars.length, 3);
    expect(stars[0].flux, greaterThanOrEqualTo(stars[1].flux));
    expect(stars[1].flux, greaterThanOrEqualTo(stars[2].flux));
  });

  test('returns nothing on a uniform plane with no sources', () {
    final LuminancePlane plane = _makeBlankPlane(50, 50, 0.3);
    _addSeededNoise(plane, 0.02, 999);
    final List<DetectedStar> stars = detectStars(plane, thresholdSigma: 6);
    expect(stars, isEmpty);
  });

  test('is robust to a nonzero background level', () {
    final LuminancePlane plane = _makeBlankPlane(64, 64, 1.75);
    _addGaussianStar(plane, 32, 32, 4.0, 1.4);
    final List<DetectedStar> stars = detectStars(plane, thresholdSigma: 5);
    expect(stars.length, 1);
    expect((stars[0].x - 32).abs(), lessThan(0.2));
    expect((stars[0].y - 32).abs(), lessThan(0.2));
  });

  test(
    'usePsfRefinement=true (Work118): PSF精緻化を有効にしても、'
    'sub-pixel位置にある星の検出精度が劣化しない(配線の検証)',
    () {
      const double trueX = 32.37;
      const double trueY = 31.62;
      final LuminancePlane plane = _makeBlankPlane(64, 64, 0.5);
      _addGaussianStar(plane, trueX, trueY, 5.0, 1.4);

      final List<DetectedStar> starsWithout = detectStars(
        plane,
        thresholdSigma: 5,
      );
      final List<DetectedStar> starsWith = detectStars(
        plane,
        thresholdSigma: 5,
        usePsfRefinement: true,
      );

      expect(starsWithout.length, 1);
      expect(starsWith.length, 1);
      expect((starsWith[0].x - trueX).abs(), lessThan(0.2));
      expect((starsWith[0].y - trueY).abs(), lessThan(0.2));
      // 形状診断(丸さ・鋭さ・flux等)自体はPSF精緻化の対象外であり、
      // 位置のみが変わりうる。他のフィールドは変更されないはず。
      expect(starsWith[0].flux, starsWithout[0].flux);
      expect(starsWith[0].roundness, starsWithout[0].roundness);
      expect(starsWith[0].sharpness, starsWithout[0].sharpness);
    },
  );
  test('NaN/Inf輝度を背景MADや重心計算へ流さず拒否する', () {
    final LuminancePlane nanPlane = _makeBlankPlane(16, 16);
    nanPlane.samples[5] = double.nan;
    expect(
      () => detectStars(nanPlane),
      throwsA(isA<InvalidStarDetectionInput>()),
    );

    final LuminancePlane infPlane = _makeBlankPlane(16, 16);
    infPlane.samples[7] = double.infinity;
    expect(
      () => detectStars(infPlane),
      throwsA(isA<InvalidStarDetectionInput>()),
    );
  });

  test('release時も非有限・不正な星検出パラメータを拒否する', () {
    final LuminancePlane plane = _makeBlankPlane(16, 16);
    expect(
      () => detectStars(plane, thresholdSigma: double.nan),
      throwsA(isA<InvalidStarDetectionInput>()),
    );
    expect(
      () => detectStars(plane, noiseFloorSigma: double.infinity),
      throwsA(isA<InvalidStarDetectionInput>()),
    );
    expect(
      () => detectStars(plane, windowRadius: 0),
      throwsA(isA<InvalidStarDetectionInput>()),
    );
    expect(
      () => detectStars(plane, minSeparation: -1),
      throwsA(isA<InvalidStarDetectionInput>()),
    );
  });
}
