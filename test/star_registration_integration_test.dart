import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/luminance_plane.dart';
import 'package:mobile_stack/core/registration/star_detector.dart';
import 'package:mobile_stack/core/registration/star_transform_estimator.dart';

/// Dart port of
/// `tool/raw_samples/test/star_registration_integration.test.mjs`: runs
/// the actual detector on synthetic rendered star fields and feeds its
/// output into the estimator, exercising both modules together the way
/// the real registration pipeline will call them.

LuminancePlane _makePlane(int width, int height, double backgroundValue) {
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

final class _TruthStar {
  const _TruthStar(this.x, this.y, this.peak);

  final double x;
  final double y;
  final double peak;
}

List<_TruthStar> _seededRandomStarField(
  int count,
  int seed,
  double width,
  double height,
  double margin,
) {
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  final List<_TruthStar> stars = <_TruthStar>[];
  for (int i = 0; i < count; i++) {
    stars.add(
      _TruthStar(
        margin + next() * (width - 2 * margin),
        margin + next() * (height - 2 * margin),
        3 + next() * 6,
      ),
    );
  }
  return stars;
}

({double x, double y}) _rotatePoint(
  double x,
  double y,
  double rotationDegrees,
  double centerX,
  double centerY,
  double dx,
  double dy,
) {
  final double radians = rotationDegrees * math.pi / 180;
  final double cosine = math.cos(radians);
  final double sine = math.sin(radians);
  final double ox = x - centerX;
  final double oy = y - centerY;
  return (
    x: centerX + cosine * ox - sine * oy + dx,
    y: centerY + sine * ox + cosine * oy + dy,
  );
}

void main() {
  test('detector + estimator recover a known small transform end to end', () {
    const int width = 240;
    const int height = 200;
    const double trueRotation = 2.2;
    const double trueDx = 6.4;
    const double trueDy = -3.1;
    const double centerX = width / 2;
    const double centerY = height / 2;

    final List<_TruthStar> truth = _seededRandomStarField(
      30,
      2024,
      width.toDouble(),
      height.toDouble(),
      20,
    );

    final LuminancePlane referencePlane = _makePlane(width, height, 0.15);
    for (final _TruthStar star in truth) {
      _addGaussianStar(referencePlane, star.x, star.y, star.peak, 1.3);
    }
    _addSeededNoise(referencePlane, 0.03, 111);

    final LuminancePlane targetPlane = _makePlane(width, height, 0.15);
    for (final _TruthStar star in truth) {
      final ({double x, double y}) moved = _rotatePoint(
        star.x,
        star.y,
        trueRotation,
        centerX,
        centerY,
        trueDx,
        trueDy,
      );
      _addGaussianStar(targetPlane, moved.x, moved.y, star.peak, 1.3);
    }
    _addSeededNoise(targetPlane, 0.03, 222);

    final List<DetectedStar> referenceStars =
        detectStars(referencePlane, thresholdSigma: 5);
    final List<DetectedStar> targetStars =
        detectStars(targetPlane, thresholdSigma: 5);

    expect(
      referenceStars.length,
      greaterThanOrEqualTo(truth.length - 4),
      reason: 'expected close to ${truth.length} reference detections, '
          'got ${referenceStars.length}',
    );
    expect(
      targetStars.length,
      greaterThanOrEqualTo(truth.length - 4),
      reason: 'expected close to ${truth.length} target detections, got '
          '${targetStars.length}',
    );

    final StarSimilarityTransformEstimate estimate =
        estimateSimilarityTransform(referenceStars, targetStars);

    expect(
      (estimate.rotationDegrees - trueRotation).abs(),
      lessThan(0.05),
      reason: 'expected rotation near $trueRotation, got '
          '${estimate.rotationDegrees}',
    );
    expect(estimate.inlierCount, greaterThanOrEqualTo(truth.length - 5));
    expect(estimate.rmsResidual, lessThan(1.5));

    // Cross-check a few individual reference detections actually land
    // near their corresponding target detections under the estimated
    // transform, using the same forward-mapping convention as
    // AffineSamplingTransform.similarity.
    final double radians = estimate.rotationDegrees * math.pi / 180;
    final double cosine = math.cos(radians);
    final double sine = math.sin(radians);
    ({double x, double y}) forward(double x, double y) {
      final double ox = x - estimate.centerX;
      final double oy = y - estimate.centerY;
      return (
        x: estimate.centerX + cosine * ox - sine * oy + estimate.sourceOffsetX,
        y: estimate.centerY + sine * ox + cosine * oy + estimate.sourceOffsetY,
      );
    }

    int checked = 0;
    for (final StarMatch match in estimate.matches.take(5)) {
      final DetectedStar reference = referenceStars[match.referenceIndex];
      final DetectedStar target = targetStars[match.targetIndex];
      final ({double x, double y}) predicted =
          forward(reference.x, reference.y);
      expect(
        math.sqrt(
          math.pow(predicted.x - target.x, 2) +
              math.pow(predicted.y - target.y, 2),
        ),
        lessThan(1.0),
      );
      checked += 1;
    }
    expect(checked, greaterThanOrEqualTo(5));
  });

  test(
    'detector + estimator remain stable across a full simulated stacking '
    'burst',
    () {
      const int width = 220;
      const int height = 220;
      const double centerX = width / 2;
      const double centerY = height / 2;
      final List<_TruthStar> truth = _seededRandomStarField(
        26,
        909,
        width.toDouble(),
        height.toDouble(),
        20,
      );
      const int frameCount = 5;
      const double rotationPerFrame = 1.1; // degrees, cumulative
      const double driftDx = 1.4; // px per frame, cumulative
      const double driftDy = -0.9;

      LuminancePlane renderFrame(int frameIndex) {
        final LuminancePlane plane = _makePlane(width, height, 0.15);
        for (final _TruthStar star in truth) {
          final ({double x, double y}) moved = _rotatePoint(
            star.x,
            star.y,
            rotationPerFrame * frameIndex,
            centerX,
            centerY,
            driftDx * frameIndex,
            driftDy * frameIndex,
          );
          _addGaussianStar(plane, moved.x, moved.y, star.peak, 1.3);
        }
        _addSeededNoise(plane, 0.03, 1000 + frameIndex);
        return plane;
      }

      final List<DetectedStar> referenceStars =
          detectStars(renderFrame(0), thresholdSigma: 5);
      for (int frameIndex = 1; frameIndex < frameCount; frameIndex++) {
        final List<DetectedStar> targetStars =
            detectStars(renderFrame(frameIndex), thresholdSigma: 5);
        final StarSimilarityTransformEstimate estimate =
            estimateSimilarityTransform(referenceStars, targetStars);
        final double expectedRotation = rotationPerFrame * frameIndex;
        expect(
          (estimate.rotationDegrees - expectedRotation).abs(),
          lessThan(0.1),
          reason: 'frame $frameIndex: expected rotation near '
              '$expectedRotation, got ${estimate.rotationDegrees}',
        );
        expect(
          estimate.inlierCount,
          greaterThanOrEqualTo(truth.length - 4),
          reason: 'frame $frameIndex: only ${estimate.inlierCount} inliers',
        );
        expect(estimate.rmsResidual, lessThan(1.5));
      }
    },
  );
}
