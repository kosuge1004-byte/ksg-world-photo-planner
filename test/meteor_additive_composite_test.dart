import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/meteor/streak_compositor.dart';
import 'package:mobile_stack/core/meteor/streak_shape.dart';

/// Work357. Mirrors tool/raw_samples/test/meteor_additive_composite_reference.test.mjs.

final class _Streak implements StreakShape {
  _Streak(this.endpoints, this.width);
  @override
  final List<({double x, double y})> endpoints;
  @override
  final double width;
}

void main() {
  test('additive keeps the band clean and the core equal to fg minus sky', () {
    const int w = 160, h = 100;
    final math.Random r = math.Random(3);
    double g() {
      final double u = math.max(r.nextDouble(), 1e-12);
      return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * r.nextDouble());
    }

    final Float32List bg = Float32List(w * h * 3);
    final Float32List fg = Float32List(w * h * 3);
    for (int p = 0; p < w * h; p++) {
      final int x = p % w, y = p ~/ w;
      final bool on = x >= 20 && x <= 140 && (y - (50 + (x - 20) / 60)).abs() <= 1;
      for (int c = 0; c < 3; c++) {
        bg[p * 3 + c] = 0.05 + 0.001 * g() + (on ? 0.01 : 0);
        fg[p * 3 + c] = 0.052 + 0.01 * g() + (on ? 0.4 : 0);
      }
    }
    final StreakShape streak =
        _Streak(<({double x, double y})>[(x: 20, y: 50), (x: 140, y: 52)], 3);
    final LinearRgbTile bgTile =
        LinearRgbTile(x: 0, y: 0, width: w, height: h, interleavedRgb: bg);
    final LinearRgbTile fgTile =
        LinearRgbTile(x: 0, y: 0, width: w, height: h, interleavedRgb: fg);
    final StreakAdditiveParameters p = estimateStreakAdditiveParameters(
      background: bgTile,
      foreground: fgTile,
      streak: streak,
    );
    expect(p.usable, isTrue);
    expect(p.offset[1], closeTo(0.002, 0.001));
    final LinearRgbTile dest = LinearRgbTile(
        x: 0, y: 0, width: w, height: h, interleavedRgb: Float32List.fromList(bg));
    compositeSelectedStreaksAdditiveInPlace(
      destination: dest,
      foreground: fgTile,
      streaks: <StreakShape>[streak],
      parameters: <StreakAdditiveParameters>[p],
    );
    double band = 0, core = 0;
    int nb = 0, nc = 0;
    for (int x = 30; x < 130; x++) {
      final int yc = (50 + (x - 20) / 60).round();
      core += dest.interleavedRgb[(yc * w + x) * 3 + 1];
      nc++;
      for (final int dy in <int>[-4, -3, 3, 4]) {
        band += dest.interleavedRgb[((yc + dy) * w + x) * 3 + 1] - 0.05;
        nb++;
      }
    }
    expect((band / nb).abs(), lessThan(0.0015));
    expect(core / nc, closeTo(0.45, 0.01));
  });

  test('radiant is found and a crossing satellite is inconsistent', () {
    const ({double x, double y}) radiant = (x: 2500, y: -800);
    final math.Random r = math.Random(9);
    final List<StreakShape> streaks = <StreakShape>[];
    for (int k = 0; k < 6; k++) {
      final double mx = 500 + 4000 * r.nextDouble();
      final double my = 500 + 3000 * r.nextDouble();
      final double dx = mx - radiant.x, dy = my - radiant.y;
      final double l = math.sqrt(dx * dx + dy * dy);
      final double len = 150 + 200 * r.nextDouble();
      streaks.add(_Streak(<({double x, double y})>[
        (x: mx - dx / l * len / 2, y: my - dy / l * len / 2),
        (x: mx + dx / l * len / 2, y: my + dy / l * len / 2),
      ], 3));
    }
    streaks.add(_Streak(
        <({double x, double y})>[(x: 1000, y: 3000), (x: 1400, y: 3010)], 3));
    final MeteorRadiantEstimate e = estimateMeteorRadiant(streaks);
    expect(e.radiant, isNotNull);
    expect(e.consistent, <bool>[true, true, true, true, true, true, false]);
  });
}
