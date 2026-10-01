import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/meteor/streak_compositor.dart';
import 'package:mobile_stack/core/meteor/streak_shape.dart';

/// Dart port of `tool/raw_samples/test/streak_compositor_reference.
/// test.mjs`.

LinearRgbTile _makeFlatRgb(
  int width,
  int height,
  double r,
  double g,
  double b,
) {
  final Float32List rgb = Float32List(width * height * 3);
  for (int pixel = 0; pixel < width * height; pixel++) {
    rgb[pixel * 3] = r;
    rgb[pixel * 3 + 1] = g;
    rgb[pixel * 3 + 2] = b;
  }
  return LinearRgbTile(
    x: 0,
    y: 0,
    width: width,
    height: height,
    interleavedRgb: rgb,
  );
}

final class _Streak implements StreakShape {
  _Streak(double x0, double y0, double x1, double y1, [double streakWidth = 2])
      : endpoints = <({double x, double y})>[(x: x0, y: y0), (x: x1, y: y1)],
        width = streakWidth;

  @override
  final List<({double x, double y})> endpoints;
  @override
  final double width;
}

void main() {
  test('rejects mismatched dimensions between background and foreground', () {
    final LinearRgbTile background = _makeFlatRgb(10, 10, 0, 0, 0);
    final LinearRgbTile foreground = _makeFlatRgb(5, 5, 0, 0, 0);
    expect(
      () => compositeSelectedStreaks(
        background: background,
        foreground: foreground,
        streaks: <StreakShape>[_Streak(0, 0, 1, 1)],
      ),
      throwsA(isA<InvalidStreakCompositeInput>()),
    );
  });

  test('rejects an empty streak selection', () {
    final LinearRgbTile background = _makeFlatRgb(10, 10, 0, 0, 0);
    final LinearRgbTile foreground = _makeFlatRgb(10, 10, 1, 1, 1);
    expect(
      () => compositeSelectedStreaks(
        background: background,
        foreground: foreground,
        streaks: const <StreakShape>[],
      ),
      throwsA(isA<InvalidStreakCompositeInput>()),
    );
  });

  test('buildStreakMask marks pixels near the segment, none elsewhere', () {
    const int width = 40;
    const int height = 20;
    final _Streak streak = _Streak(5, 10, 35, 10, 2); // horizontal, width 2
    final Uint8List mask = buildStreakMask(
      width: width,
      height: height,
      streaks: <StreakShape>[streak],
      paddingPixels: 1,
    );
    // radius = width/2 + padding = 1 + 1 = 2
    // A point directly on the segment must be marked.
    expect(mask[10 * width + 20], 1);
    // A point 2px above the segment (within radius) must be marked.
    expect(mask[8 * width + 20], 1);
    // A point far above the segment must not be marked.
    expect(mask[1 * width + 20], 0);
    // A point far to the left of the segment's start must not be marked.
    expect(mask[10 * width + 0], 0);
  });

  test('buildStreakMask unions multiple streaks without double-processing', () {
    const int width = 60;
    const int height = 60;
    final List<StreakShape> streaks = <StreakShape>[
      _Streak(5, 5, 15, 5, 2),
      _Streak(40, 40, 50, 50, 2),
    ];
    final Uint8List mask = buildStreakMask(
      width: width,
      height: height,
      streaks: streaks,
      paddingPixels: 1,
    );
    expect(mask[5 * width + 10], 1); // on the first streak
    expect(mask[45 * width + 45], 1); // on the second streak
    expect(mask[30 * width + 30], 0); // between them, untouched
  });

  test('non-zero tile origin maps global streak coordinates locally', () {
    final Uint8List mask = buildStreakMask(
      width: 10,
      height: 10,
      originX: 20,
      originY: 30,
      streaks: <StreakShape>[_Streak(22, 35, 28, 35, 2)],
      paddingPixels: 0,
    );
    expect(mask[5 * 10 + 5], 1); // global (25,35)
    expect(mask[0], 0); // global (20,30)
  });

  test('in-place compositing mutates only the translated tile mask', () {
    final LinearRgbTile destination = LinearRgbTile(
      x: 20,
      y: 30,
      width: 10,
      height: 10,
      interleavedRgb: Float32List(10 * 10 * 3)..fillRange(0, 300, 0.1),
    );
    final LinearRgbTile foreground = LinearRgbTile(
      x: 20,
      y: 30,
      width: 10,
      height: 10,
      interleavedRgb: Float32List(10 * 10 * 3)..fillRange(0, 300, 9),
    );
    compositeSelectedStreaksInPlace(
      destination: destination,
      foreground: foreground,
      streaks: <StreakShape>[_Streak(22, 35, 28, 35, 2)],
      paddingPixels: 0,
    );
    expect(destination.interleavedRgb[(5 * 10 + 5) * 3], 9);
    expect(destination.interleavedRgb[0], closeTo(0.1, 1e-6));
  });

  test(
    'composites only the masked region; background elsewhere is untouched',
    () {
      const int width = 30;
      const int height = 20;
      final LinearRgbTile background =
          _makeFlatRgb(width, height, 0.1, 0.1, 0.1);
      final LinearRgbTile foreground =
          _makeFlatRgb(width, height, 9.0, 9.0, 9.0);
      final _Streak streak = _Streak(5, 10, 25, 10, 2);
      final LinearRgbTile result = compositeSelectedStreaks(
        background: background,
        foreground: foreground,
        streaks: <StreakShape>[streak],
        paddingPixels: 1,
      );

      // On the streak: the (much brighter) foreground value should win.
      final int onStreak = (10 * width + 15) * 3;
      expect((result.interleavedRgb[onStreak] - 9.0).abs(), lessThan(1e-6));

      // Far from the streak: the background value must be unchanged.
      final int farAway = (2 * width + 2) * 3;
      expect((result.interleavedRgb[farAway] - 0.1).abs(), lessThan(1e-6));

      // The inputs must not have been mutated.
      expect(
        (background.interleavedRgb[onStreak] - 0.1).abs(),
        lessThan(1e-6),
      );
    },
  );

  test(
    'lighten (max) blending: a dimmer foreground never darkens the '
    'background',
    () {
      const int width = 20;
      const int height = 20;
      final LinearRgbTile background =
          _makeFlatRgb(width, height, 5.0, 5.0, 5.0);
      final LinearRgbTile foreground =
          _makeFlatRgb(width, height, 0.5, 0.5, 0.5); // dimmer
      final _Streak streak = _Streak(2, 10, 18, 10, 2);
      final LinearRgbTile result = compositeSelectedStreaks(
        background: background,
        foreground: foreground,
        streaks: <StreakShape>[streak],
        paddingPixels: 1,
      );
      final int onStreak = (10 * width + 10) * 3;
      // The brighter background value should survive, not be overwritten
      // by the dimmer foreground -- this is what makes it safe to
      // composite a streak that happens to cross an already-bright area
      // (e.g. the Milky Way core) without punching a dark hole in it.
      expect((result.interleavedRgb[onStreak] - 5.0).abs(), lessThan(1e-6));
    },
  );

  test('per-channel blending: channels combine independently', () {
    const int width = 10;
    const int height = 10;
    final LinearRgbTile background = _makeFlatRgb(width, height, 9.0, 0.1, 0.1);
    final LinearRgbTile foreground = _makeFlatRgb(width, height, 0.1, 9.0, 0.1);
    final _Streak streak = _Streak(1, 5, 8, 5, 2);
    final LinearRgbTile result = compositeSelectedStreaks(
      background: background,
      foreground: foreground,
      streaks: <StreakShape>[streak],
      paddingPixels: 1,
    );
    final int onStreak = (5 * width + 4) * 3;
    expect(
      (result.interleavedRgb[onStreak] - 9.0).abs(),
      lessThan(1e-6),
    ); // red from bg
    expect(
      (result.interleavedRgb[onStreak + 1] - 9.0).abs(),
      lessThan(1e-6),
    ); // green from fg
    expect(
      (result.interleavedRgb[onStreak + 2] - 0.1).abs(),
      lessThan(1e-6),
    ); // blue: tied
  });

  test(
    'a zero-length streak (degenerate endpoints) still produces a small '
    'round mask',
    () {
      const int width = 20;
      const int height = 20;
      // Both endpoints identical.
      final _Streak streak = _Streak(10, 10, 10, 10, 4);
      final Uint8List mask = buildStreakMask(
        width: width,
        height: height,
        streaks: <StreakShape>[streak],
        paddingPixels: 1,
      );
      expect(mask[10 * width + 10], 1);
      // radius = 4/2 + 1 = 3
      expect(mask[10 * width + 13], 1);
      expect(mask[10 * width + 15], 0);
    },
  );
}
