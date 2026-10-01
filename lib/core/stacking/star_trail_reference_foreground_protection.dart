import 'dart:math' as math;
import 'dart:typed_data';
import '../image/linear_rgb_tile.dart';

/// Suppresses broad transient brightening only inside an explicit foreground
/// mask. Sliding neighborhoods and continuous blending replace the old binary
/// 16x16 block replacement. Callers read a halo so decisions are tile invariant.
void preserveReferenceAgainstBroadTransientBrightening({
  required LinearRgbTile combined,
  required LinearRgbTile reference,
  required Float32List foregroundWeights,
  int blockSize = 16,
  double minimumBrightenedFraction = 0.50,
  double absoluteLumaIncrease = 0.008,
  double relativeLumaIncrease = 0.10,
}) {
  if (combined.x != reference.x ||
      combined.y != reference.y ||
      combined.width != reference.width ||
      combined.height != reference.height ||
      foregroundWeights.length != combined.width * combined.height) {
    throw ArgumentError(
        'Combined/reference/mask tiles must have identical bounds.');
  }
  if (blockSize <= 0 ||
      !minimumBrightenedFraction.isFinite ||
      minimumBrightenedFraction <= 0 ||
      minimumBrightenedFraction >= 1 ||
      !absoluteLumaIncrease.isFinite ||
      absoluteLumaIncrease < 0 ||
      !relativeLumaIncrease.isFinite ||
      relativeLumaIncrease < 0 ||
      foregroundWeights.any((v) => !v.isFinite || v < 0 || v > 1)) {
    throw ArgumentError('Invalid foreground-protection thresholds/mask.');
  }
  final data = combined.interleavedRgb, ref = reference.interleavedRgb;
  if (data.any((v) => !v.isFinite) || ref.any((v) => !v.isFinite)) {
    throw StateError('Foreground protection received non-finite RGB.');
  }
  final w = combined.width, h = combined.height, stride = w + 1;
  final bright = Uint8List(w * h);
  final illuminated = Float64List((w + 1) * (h + 1));
  final eligible = Float64List(illuminated.length);
  for (int y = 0; y < h; y++) {
    double rowBright = 0, rowWeight = 0;
    for (int x = 0; x < w; x++) {
      final pixel = y * w + x, base = pixel * 3;
      final weight = foregroundWeights[pixel];
      final luma =
          .2126 * data[base] + .7152 * data[base + 1] + .0722 * data[base + 2];
      final referenceLuma =
          .2126 * ref[base] + .7152 * ref[base + 1] + .0722 * ref[base + 2];
      final threshold = absoluteLumaIncrease +
          relativeLumaIncrease * math.max(referenceLuma.abs(), .02);
      if (weight > 0 && luma - referenceLuma > threshold) bright[pixel] = 1;
      rowBright += weight * bright[pixel];
      rowWeight += weight;
      final index = (y + 1) * stride + x + 1;
      illuminated[index] = illuminated[index - stride] + rowBright;
      eligible[index] = eligible[index - stride] + rowWeight;
    }
  }
  double box(Float64List integral, int x0, int y0, int x1, int y1) =>
      integral[y1 * stride + x1] -
      integral[y0 * stride + x1] -
      integral[y1 * stride + x0] +
      integral[y0 * stride + x0];
  final radius = blockSize ~/ 2;
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      final pixel = y * w + x;
      if (bright[pixel] == 0 || foregroundWeights[pixel] == 0) continue;
      final x0 = math.max(0, x - radius), x1 = math.min(w, x + radius + 1);
      final y0 = math.max(0, y - radius), y1 = math.min(h, y + radius + 1);
      final count = box(eligible, x0, y0, x1, y1);
      if (count <= 0) continue;
      final fraction = box(illuminated, x0, y0, x1, y1) / count;
      final t = ((fraction - minimumBrightenedFraction) /
              (1 - minimumBrightenedFraction))
          .clamp(0.0, 1.0);
      final strength = foregroundWeights[pixel] * t * t * (3 - 2 * t);
      if (strength == 0) continue;
      for (int channel = 0; channel < 3; channel++) {
        final offset = pixel * 3 + channel;
        data[offset] += (ref[offset] - data[offset]) * strength;
      }
    }
  }
}
