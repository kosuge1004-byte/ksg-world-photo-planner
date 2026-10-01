import 'dart:math' as math;

import '../registration/luminance_plane.dart';

final class FocusFeaturePoint {
  const FocusFeaturePoint({
    required this.x,
    required this.y,
    required this.response,
  });

  final double x;
  final double y;
  final double response;
}

/// Detects well-localized scene features using the smaller eigenvalue of a
/// 2x2 structure tensor (Shi-Tomasi response) on linear luminance.
///
/// Gradients are central differences. The tensor is accumulated over a local
/// square support. Non-maximum suppression prevents many nearly-identical
/// points from one textured edge. No gamma/tone/sharpening is applied.
List<FocusFeaturePoint> detectFocusFeatures(
  LuminancePlane luminance, {
  int tensorRadius = 2,
  int suppressionRadius = 5,
  int maximumFeatures = 256,
  double minimumResponse = 0,
}) {
  if (tensorRadius < 1 || tensorRadius > 16) {
    throw ArgumentError.value(tensorRadius, 'tensorRadius');
  }
  if (suppressionRadius < 1 || suppressionRadius > 64) {
    throw ArgumentError.value(suppressionRadius, 'suppressionRadius');
  }
  if (maximumFeatures < 4 || maximumFeatures > 4096) {
    throw ArgumentError.value(maximumFeatures, 'maximumFeatures');
  }
  if (!minimumResponse.isFinite || minimumResponse < 0) {
    throw ArgumentError.value(minimumResponse, 'minimumResponse');
  }

  final int width = luminance.width;
  final int height = luminance.height;
  if (width < 2 * tensorRadius + 3 || height < 2 * tensorRadius + 3) {
    return const <FocusFeaturePoint>[];
  }
  if (luminance.samples.any((double value) => !value.isFinite)) {
    throw ArgumentError('Luminance contains a non-finite sample.');
  }

  final List<_Candidate> candidates = <_Candidate>[];
  final int border = tensorRadius + 1;
  for (int y = border; y < height - border; y++) {
    for (int x = border; x < width - border; x++) {
      double a = 0;
      double b = 0;
      double c = 0;
      for (int dy = -tensorRadius; dy <= tensorRadius; dy++) {
        final int yy = y + dy;
        for (int dx = -tensorRadius; dx <= tensorRadius; dx++) {
          final int xx = x + dx;
          final double gx = 0.5 *
              (luminance.samples[yy * width + xx + 1] -
                  luminance.samples[yy * width + xx - 1]);
          final double gy = 0.5 *
              (luminance.samples[(yy + 1) * width + xx] -
                  luminance.samples[(yy - 1) * width + xx]);
          a += gx * gx;
          b += gx * gy;
          c += gy * gy;
        }
      }
      final double trace = a + c;
      final double discriminant = math.max(0, (a - c) * (a - c) + 4 * b * b);
      final double response = 0.5 * (trace - math.sqrt(discriminant));
      if (response.isFinite && response > minimumResponse) {
        candidates.add(_Candidate(x: x, y: y, response: response));
      }
    }
  }

  candidates.sort((_Candidate a, _Candidate b) {
    final int responseOrder = b.response.compareTo(a.response);
    if (responseOrder != 0) return responseOrder;
    final int yOrder = a.y.compareTo(b.y);
    return yOrder != 0 ? yOrder : a.x.compareTo(b.x);
  });

  final int suppressionSquared = suppressionRadius * suppressionRadius;
  final List<FocusFeaturePoint> selected = <FocusFeaturePoint>[];
  for (final _Candidate candidate in candidates) {
    bool tooClose = false;
    for (final FocusFeaturePoint existing in selected) {
      final double dx = existing.x - candidate.x;
      final double dy = existing.y - candidate.y;
      if (dx * dx + dy * dy <= suppressionSquared) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    selected.add(
      FocusFeaturePoint(
        x: candidate.x.toDouble(),
        y: candidate.y.toDouble(),
        response: candidate.response,
      ),
    );
    if (selected.length >= maximumFeatures) break;
  }
  return List<FocusFeaturePoint>.unmodifiable(selected);
}

final class _Candidate {
  const _Candidate({
    required this.x,
    required this.y,
    required this.response,
  });

  final int x;
  final int y;
  final double response;
}
