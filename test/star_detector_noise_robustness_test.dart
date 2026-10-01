import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/luminance_plane.dart';
import 'package:mobile_stack/core/registration/star_detector.dart';

/// Dart port of `tool/raw_samples/test/star_detector_noise_robustness.
/// test.mjs`. See that file's doc comment and WORK44_PROGRESS.md for the
/// investigation this covers: can high-ISO sensor noise be misidentified
/// as a star, and does the [noiseFloorSigma] fix (ported from the Node
/// reference alongside this test) hold up against realistic noise.

LuminancePlane _makeBlankPlane(int width, int height, double backgroundValue) {
  final Float32List samples = Float32List(width * height)
    ..fillRange(0, width * height, backgroundValue);
  return LuminancePlane(width: width, height: height, samples: samples);
}

/// Gaussian (not uniform) per-pixel read noise via the Box-Muller
/// transform. See the Node reference test's equivalent doc comment for
/// why Gaussian (not uniform) noise matters for this specific
/// investigation (tail-driven false positives).
void _addGaussianReadNoise(
  LuminancePlane plane,
  double standardDeviation,
  int seed,
) {
  int state = seed;
  double nextUniform() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return math.max(1e-9, state / 0x7fffffff);
  }

  for (int i = 0; i < plane.samples.length; i += 2) {
    final double u1 = nextUniform();
    final double u2 = nextUniform();
    final double radius = math.sqrt(-2 * math.log(u1));
    final double angle = 2 * math.pi * u2;
    plane.samples[i] += radius * math.cos(angle) * standardDeviation;
    if (i + 1 < plane.samples.length) {
      plane.samples[i + 1] += radius * math.sin(angle) * standardDeviation;
    }
  }
}

final class _WarmPixel {
  const _WarmPixel(this.x, this.y, this.amplitude);

  final int x;
  final int y;
  final double amplitude;
}

/// Scatters [count] single-pixel warm/hot pixels at random locations --
/// the "perfectly sharp, single-pixel defect" case.
List<_WarmPixel> _addRandomWarmPixels(
  LuminancePlane plane,
  int count,
  double minAmplitude,
  double maxAmplitude,
  int seed,
) {
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  final List<_WarmPixel> positions = <_WarmPixel>[];
  for (int i = 0; i < count; i++) {
    final int x = (next() * plane.width).floor();
    final int y = (next() * plane.height).floor();
    final double amplitude =
        minAmplitude + next() * (maxAmplitude - minAmplitude);
    plane.samples[y * plane.width + x] += amplitude;
    positions.add(_WarmPixel(x, y, amplitude));
  }
  return positions;
}

/// Scatters [count] *blurred* warm pixels: the defect's charge diffuses
/// into a small neighborhood, unlike [_addRandomWarmPixels]'s perfectly
/// sharp spike -- closer to some real sensor defects, and a harder case
/// for the sharpness gate.
List<_WarmPixel> _addBlurredWarmPixels(
  LuminancePlane plane,
  int count,
  double minAmplitude,
  double maxAmplitude,
  double blurSigma,
  int seed,
) {
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  final List<_WarmPixel> positions = <_WarmPixel>[];
  for (int i = 0; i < count; i++) {
    final int cx = (next() * plane.width).floor();
    final int cy = (next() * plane.height).floor();
    final double amplitude =
        minAmplitude + next() * (maxAmplitude - minAmplitude);
    for (int dy = -2; dy <= 2; dy++) {
      for (int dx = -2; dx <= 2; dx++) {
        final int x = cx + dx;
        final int y = cy + dy;
        if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) {
          continue;
        }
        final double value = amplitude *
            math.exp(-(dx * dx + dy * dy) / (2 * blurSigma * blurSigma));
        plane.samples[y * plane.width + x] += value;
      }
    }
    positions.add(_WarmPixel(cx, cy, amplitude));
  }
  return positions;
}

void main() {
  test(
    'pure Gaussian read noise, no stars and no warm pixels, produces '
    'very few false detections at the default threshold',
    () {
      const int width = 200;
      const int height = 200;
      int totalFalsePositives = 0;
      const List<int> seeds = <int>[1, 2, 3, 4, 5];
      for (final int seed in seeds) {
        final LuminancePlane plane = _makeBlankPlane(width, height, 0.15);
        _addGaussianReadNoise(plane, 0.01, seed);
        totalFalsePositives += detectStars(plane).length;
      }
      expect(
        totalFalsePositives,
        lessThanOrEqualTo(2),
        reason: 'expected at most ~0-2 false positives across '
            '${seeds.length} ${width}x$height noise-only trials at the '
            'default threshold, got $totalFalsePositives total',
      );
    },
  );

  test(
    'increasing read noise alone (no warm pixels) does not blow up the '
    'false-positive rate, because the threshold is derived from that '
    "same noise's own robust sigma estimate",
    () {
      const int width = 150;
      const int height = 150;
      for (final double readNoiseStd in <double>[0.005, 0.02, 0.05, 0.1]) {
        int falsePositives = 0;
        for (final int seed in <int>[10, 20, 30]) {
          final LuminancePlane plane = _makeBlankPlane(width, height, 0.15);
          _addGaussianReadNoise(plane, readNoiseStd, seed);
          falsePositives += detectStars(plane).length;
        }
        expect(
          falsePositives,
          lessThanOrEqualTo(3),
          reason: 'readNoiseStd=$readNoiseStd: expected a low '
              'false-positive count across 3 trials, got $falsePositives',
        );
      }
    },
  );

  test(
    'many scattered single-pixel warm/hot pixels are correctly rejected '
    'by the sharpness gate, not just one isolated example',
    () {
      const int width = 200;
      const int height = 200;
      final LuminancePlane plane = _makeBlankPlane(width, height, 0.15);
      _addGaussianReadNoise(plane, 0.01, 999);
      final List<_WarmPixel> warmPixels =
          _addRandomWarmPixels(plane, 60, 3.0, 15.0, 4242);
      final List<DetectedStar> stars = detectStars(plane);

      for (final DetectedStar star in stars) {
        final double nearestWarmPixelDistance = warmPixels.fold(
          double.infinity,
          (double best, _WarmPixel warm) => math.min(
            best,
            math.sqrt(
              math.pow(star.x - warm.x, 2) + math.pow(star.y - warm.y, 2),
            ),
          ),
        );
        expect(
          nearestWarmPixelDistance,
          greaterThan(1.5),
          reason: 'a detected "star" at (${star.x.toStringAsFixed(2)}, '
              '${star.y.toStringAsFixed(2)}) sits on top of a synthetic '
              'warm pixel, with sharpness '
              '${star.sharpness.toStringAsFixed(3)}',
        );
      }
    },
  );

  test(
    'a blurred (multi-pixel, not perfectly sharp) warm pixel is a '
    'harder case: characterizes where the sharpness gate stops '
    'catching it',
    () {
      const int width = 150;
      const int height = 150;
      final List<({double blurSigma, int falsePositiveCount})> results =
          <({double blurSigma, int falsePositiveCount})>[];
      for (final double blurSigma in <double>[0.3, 0.5, 0.7, 0.9, 1.1, 1.3]) {
        final LuminancePlane plane = _makeBlankPlane(width, height, 0.15);
        _addGaussianReadNoise(plane, 0.01, 1000);
        final List<_WarmPixel> warmPixels = _addBlurredWarmPixels(
          plane,
          10,
          4.0,
          10.0,
          blurSigma,
          5000,
        );
        final List<DetectedStar> stars = detectStars(plane);
        int caughtCount = 0;
        for (final _WarmPixel warm in warmPixels) {
          final bool matched = stars.any(
            (DetectedStar star) =>
                math.sqrt(
                  math.pow(star.x - warm.x, 2) + math.pow(star.y - warm.y, 2),
                ) <
                1.5,
          );
          if (matched) caughtCount += 1;
        }
        results.add((blurSigma: blurSigma, falsePositiveCount: caughtCount));
      }

      // At the sharpest end (blurSigma 0.3, barely spread beyond a
      // single pixel), essentially none should slip through.
      expect(
        results.first.falsePositiveCount,
        0,
        reason: 'blurSigma=${results.first.blurSigma}: expected the '
            'sharpness gate to catch all near-single-pixel defects',
      );

      // Reported for visibility, matching the Node reference test's
      // intent: the measured boundary where detections start slipping
      // through is meaningful information, not something to hide behind
      // a narrow pass/fail. See WORK44_PROGRESS.md.
      // ignore: avoid_print
      print('blurred warm-pixel sharpness-gate boundary: $results');
    },
  );

  test(
    'a dim, compact real star is not accidentally rejected by the same '
    'gates that catch warm-pixel noise (the gates must not overcorrect)',
    () {
      const int width = 150;
      const int height = 150;
      final LuminancePlane plane = _makeBlankPlane(width, height, 0.15);
      _addGaussianReadNoise(plane, 0.01, 7777);
      const double trueX = 75.3;
      const double trueY = 82.7;
      for (int dy = -6; dy <= 6; dy++) {
        for (int dx = -6; dx <= 6; dx++) {
          final int x = trueX.round() + dx;
          final int y = trueY.round() + dy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          final double ox = x - trueX;
          final double oy = y - trueY;
          plane.samples[y * width + x] +=
              3.5 * math.exp(-(ox * ox + oy * oy) / (2 * 1.3 * 1.3));
        }
      }
      final List<DetectedStar> stars = detectStars(plane);
      final double nearest = stars.fold(
        double.infinity,
        (double best, DetectedStar star) => math.min(
          best,
          math.sqrt(
            math.pow(star.x - trueX, 2) + math.pow(star.y - trueY, 2),
          ),
        ),
      );
      expect(
        nearest,
        lessThan(0.3),
        reason: 'expected to find the real dim star near ($trueX, '
            '$trueY), nearest detection was '
            '${nearest.toStringAsFixed(3)}px away',
      );
    },
  );
}
