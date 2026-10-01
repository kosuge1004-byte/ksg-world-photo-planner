import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/meteor/streak_compositor.dart';
import 'package:mobile_stack/core/meteor/streak_shape.dart';

final class _TestStreak implements StreakShape {
  const _TestStreak({required this.endpoints, required this.width});

  @override
  final List<({double x, double y})> endpoints;

  @override
  final double width;
}

void main() {
  test('direct in-place streak composite matches public mask semantics', () {
    const int width = 17;
    const int height = 11;
    final Float32List background = Float32List(width * height * 3);
    final Float32List foreground = Float32List(width * height * 3);
    for (int i = 0; i < background.length; i++) {
      background[i] = (i % 23) / 23.0;
      foreground[i] = ((i * 7 + 5) % 31) / 19.0;
    }
    final List<StreakShape> streaks = <StreakShape>[
      const _TestStreak(
        endpoints: <({double x, double y})>[
          (x: 2.0, y: 2.0),
          (x: 14.0, y: 8.0),
        ],
        width: 2.5,
      ),
      const _TestStreak(
        endpoints: <({double x, double y})>[
          (x: 6.0, y: 1.0),
          (x: 7.0, y: 9.0),
        ],
        width: 1.5,
      ),
    ];
    final Uint8List mask = buildStreakMask(
      width: width,
      height: height,
      streaks: streaks,
      paddingPixels: 3,
    );
    final Float32List expected = Float32List.fromList(background);
    for (int pixel = 0; pixel < mask.length; pixel++) {
      if (mask[pixel] == 0) continue;
      final int base = pixel * 3;
      for (int c = 0; c < 3; c++) {
        if (foreground[base + c] > expected[base + c]) {
          expected[base + c] = foreground[base + c];
        }
      }
    }
    final LinearRgbTile destination = LinearRgbTile(
      x: 0,
      y: 0,
      width: width,
      height: height,
      interleavedRgb: Float32List.fromList(background),
    );
    compositeSelectedStreaksInPlace(
      destination: destination,
      foreground: LinearRgbTile(
        x: 0,
        y: 0,
        width: width,
        height: height,
        interleavedRgb: foreground,
      ),
      streaks: streaks,
      paddingPixels: 3,
    );
    expect(destination.interleavedRgb, orderedEquals(expected));
  });
}
