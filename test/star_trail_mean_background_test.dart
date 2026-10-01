import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/stacking/star_trail_mean_background.dart';

/// Work356. Mirrors tool/raw_samples/test/star_trail_mean_background_reference.test.mjs.
void main() {
  test('sky takes the mean; trails keep the maximum', () {
    const int w = 200, h = 120, n = 100;
    const double sigma = 0.01;
    final math.Random r = math.Random(5);
    final Float64List sum = Float64List(w * h * 3);
    final Float32List max = Float32List(w * h * 3)
      ..fillRange(0, w * h * 3, -double.infinity);
    for (int f = 0; f < n; f++) {
      for (int p = 0; p < w * h; p++) {
        final int x = p % w, y = p ~/ w;
        final double sky = 0.05 + 0.1 * (y / h);
        final double noise = sigma * math.sqrt(sky / 0.1);
        final double star = ((y - 60).abs() <= 1 && (x - 2 * f).abs() <= 1) ? 0.3 : 0;
        for (int c = 0; c < 3; c++) {
          final double u = math.max(r.nextDouble(), 1e-12);
          final double g =
              math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * r.nextDouble());
          final double v = sky + star * (c == 2 ? 0.8 : 1) + noise * g;
          sum[p * 3 + c] += v;
          if (v > max[p * 3 + c]) max[p * 3 + c] = v;
        }
      }
    }
    final Float32List mean = Float32List.fromList(
        <double>[for (final double v in sum) v / n]);
    final List<double> levels = <double>[];
    final List<double> excess = <double>[];
    for (int p = 0; p < w * h; p += 4) {
      final double a = (mean[p * 3] + mean[p * 3 + 1] + mean[p * 3 + 2]) / 3;
      final double m = (max[p * 3] + max[p * 3 + 1] + max[p * 3 + 2]) / 3;
      levels.add(a);
      excess.add(m - a);
    }
    final List<StarTrailExcessBin> bins =
        starTrailExcessStatistics(levels, excess);
    final Float32List out = combineStarTrailMeanAndMaxRegion(mean, max, bins);
    double biasOut = 0;
    int count = 0;
    for (int y = 10; y < 40; y++) {
      for (int x = 0; x < w; x++) {
        final int p = (y * w + x) * 3 + 1;
        biasOut += out[p] - (0.05 + 0.1 * (y / h));
        count++;
      }
    }
    expect((biasOut / count).abs(), lessThan(0.002));
    for (int x = 4; x < 2 * (n - 2); x++) {
      final int p = (60 * w + x) * 3;
      for (int c = 0; c < 3; c++) {
        expect(out[p + c], closeTo(max[p + c], 1e-6));
      }
    }
  });

  test('ramp is monotone and saturates', () {
    expect(starTrailRampWeight(0, 0, 1), 0);
    expect(starTrailRampWeight(10, 0, 1), 1);
    expect(starTrailRampWeight(4, 0, 1), lessThan(starTrailRampWeight(5, 0, 1)));
  });
}
