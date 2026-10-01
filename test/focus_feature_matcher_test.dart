import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/focus_stack/focus_correspondence_pipeline.dart';
import 'package:mobile_stack/core/registration/luminance_plane.dart';

void main() {
  test('focus correspondence pipeline recovers a small translation', () {
    const int width = 48;
    const int height = 48;
    final List<double> a = List<double>.filled(width * height, 0);
    void stamp(List<double> image, int cx, int cy, int variant) {
      for (int y = -3; y <= 3; y++) {
        for (int x = -3; x <= 3; x++) {
          final int code = (variant + 1) * 97 + (x + 3) * 31 + (y + 3) * 17;
          image[(cy + y) * width + cx + x] =
              0.1 + 0.9 * ((code * 37 + 11) % 101) / 100;
        }
      }
    }

    final List<(int, int)> points = <(int, int)>[
      (12, 12),
      (34, 12),
      (12, 34),
      (34, 34),
      (24, 24),
    ];
    for (int index = 0; index < points.length; index++) {
      stamp(a, points[index].$1, points[index].$2, index);
    }
    final List<double> b = List<double>.filled(width * height, 0);
    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) {
        final int sx = x - 2, sy = y + 1;
        if (sx >= 0 && sy >= 0 && sx < width && sy < height) {
          b[y * width + x] = a[sy * width + sx];
        }
      }
    }
    final result = estimateFocusAlignmentFromLuminance(
      reference: LuminancePlane(
        width: width,
        height: height,
        samples: Float32List.fromList(a),
      ),
      source: LuminancePlane(
        width: width,
        height: height,
        samples: Float32List.fromList(b),
      ),
      maximumFeatures: 64,
      minimumInliers: 3,
    );
    expect(result.alignment.inlierCount, greaterThanOrEqualTo(3));
  });
}
