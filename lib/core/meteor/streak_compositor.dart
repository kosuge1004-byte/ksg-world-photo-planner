import 'dart:math' as math;
import 'dart:typed_data';

import '../image/linear_rgb_tile.dart';
import 'streak_shape.dart';

/// Dart port of `tool/raw_samples/streak_compositor_reference.mjs`.
///
/// Completes the "検出し、選んだ流星だけを背景へ合成します" (detect
/// candidates, composite only the selected one(s) onto the background)
/// workflow described in `processing_mode.dart`: given a background RGB
/// tile (typically the stack's base frame, or a separately built
/// low-noise composite of the whole sequence) and a foreground RGB tile
/// (the single frame that contains the streak the user picked from a
/// streak detector's candidates), this module blends in *only* the
/// pixels near the selected streak(s), leaving the rest of the frame
/// untouched.
///
/// This matters because the foreground frame containing a meteor is just
/// one ordinary frame from the sequence: compositing the *entire* frame
/// (rather than just the streak) would reintroduce that single frame's
/// full noise level, any other transient it happens to contain (a
/// satellite, a plane, a different unselected streak), and any minor
/// framing drift, into what should otherwise stay the clean multi-frame
/// background.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it); it is a careful line-by-line
/// translation of the Node reference, which has full test coverage. Run
/// `test/streak_compositor_test.dart` (mirroring the Node fixtures)
/// before relying on this in production.

class InvalidStreakCompositeInput extends ArgumentError {
  InvalidStreakCompositeInput(super.message);
}

void _validate(LinearRgbTile background, LinearRgbTile foreground) {
  if (background.width != foreground.width ||
      background.height != foreground.height ||
      background.x != foreground.x ||
      background.y != foreground.y) {
    throw InvalidStreakCompositeInput(
      'Background and foreground must share the same bounds.',
    );
  }
}

/// Squared distance from point `(px, py)` to the line segment
/// `(x0, y0)`-`(x1, y1)`.
double _squaredDistanceToSegment(
  double px,
  double py,
  double x0,
  double y0,
  double x1,
  double y1,
) {
  final double dx = x1 - x0;
  final double dy = y1 - y0;
  final double lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) {
    final double ox = px - x0;
    final double oy = py - y0;
    return ox * ox + oy * oy;
  }
  final double t = math.max(
    0,
    math.min(1, ((px - x0) * dx + (py - y0) * dy) / lengthSquared),
  );
  final double closestX = x0 + t * dx;
  final double closestY = y0 + t * dy;
  final double ox = px - closestX;
  final double oy = py - closestY;
  return ox * ox + oy * oy;
}

/// Builds a boolean mask (one entry per pixel, row-major) marking every
/// pixel within `streak.width / 2 + paddingPixels` of any selected
/// streak's endpoints line segment.
///
/// Exported separately from [compositeSelectedStreaks] so callers can
/// inspect, visualize, or further edit the affected region (e.g. an
/// interactive "brush to extend/trim the selection" UI) before
/// compositing.
Uint8List buildStreakMask({
  required int width,
  required int height,
  required List<StreakShape> streaks,
  double paddingPixels = 3,
  int originX = 0,
  int originY = 0,
}) {
  if (width <= 0 || height <= 0) {
    throw InvalidStreakCompositeInput(
      'Mask dimensions must be positive integers.',
    );
  }
  final Uint8List mask = Uint8List(width * height);
  if (streaks.isEmpty) return mask;

  // Bound the search to each streak's own padded bounding box rather
  // than scanning the whole frame per streak; a typical meteor streak
  // covers a small fraction of a full frame's area.
  for (final StreakShape streak in streaks) {
    final ({double x, double y}) a = streak.endpoints[0];
    final ({double x, double y}) b = streak.endpoints[1];
    final double radius = streak.width / 2 + paddingPixels;
    final int minX = math.max(
      0,
      (math.min(a.x, b.x) - radius).floor() - originX,
    );
    final int maxX = math.min(
      width - 1,
      (math.max(a.x, b.x) + radius).ceil() - originX,
    );
    final int minY = math.max(
      0,
      (math.min(a.y, b.y) - radius).floor() - originY,
    );
    final int maxY = math.min(
      height - 1,
      (math.max(a.y, b.y) + radius).ceil() - originY,
    );
    final double radiusSquared = radius * radius;
    for (int y = minY; y <= maxY; y++) {
      for (int x = minX; x <= maxX; x++) {
        final int index = y * width + x;
        if (mask[index] != 0) continue; // already covered by an earlier
        // streak
        final double distanceSquared = _squaredDistanceToSegment(
          (x + originX).toDouble(),
          (y + originY).toDouble(),
          a.x,
          a.y,
          b.x,
          b.y,
        );
        if (distanceSquared <= radiusSquared) mask[index] = 1;
      }
    }
  }
  return mask;
}

/// Composites [foreground] onto [background], restricted to pixels near
/// [streaks] (as [buildStreakMask] selects), blending each such pixel via
/// a per-channel lighten (max) — consistent with `lighten_blend_
/// combiner.dart`'s star-trail blend mode, and the natural choice for a
/// meteor: its streak should always be at least as bright as the
/// background sky/foreground behind it, never dimmer.
///
/// - [background], [foreground]: same-dimensioned [LinearRgbTile]s.
/// - [streaks]: the selected streak-shaped object(s) (only `endpoints`
///   and `width` are read).
/// - [paddingPixels] (default 3): extra margin beyond the streak's own
///   estimated width, so a slightly-underestimated width or a softly
///   anti-aliased streak edge doesn't get a hard cutoff.
///
/// Returns a new [LinearRgbTile]; does not mutate either input.
LinearRgbTile compositeSelectedStreaks({
  required LinearRgbTile background,
  required LinearRgbTile foreground,
  required List<StreakShape> streaks,
  double paddingPixels = 3,
}) {
  _validate(background, foreground);
  if (streaks.isEmpty) {
    throw InvalidStreakCompositeInput(
      'At least one streak must be selected.',
    );
  }
  final Float32List rgb = Float32List.fromList(background.interleavedRgb);
  final LinearRgbTile result = LinearRgbTile(
    x: background.x,
    y: background.y,
    width: background.width,
    height: background.height,
    interleavedRgb: rgb,
  );
  compositeSelectedStreaksInPlace(
    destination: result,
    foreground: foreground,
    streaks: streaks,
    paddingPixels: paddingPixels,
  );
  return result;
}

/// Applies [foreground] only around [streaks], mutating [destination].
///
/// This is the bounded-memory primitive used when several foreground frames
/// must be composited into one output tile. The caller owns [destination] and
/// must pass a writable tile. Global streak coordinates are translated by the
/// tile's [LinearRgbTile.x]/[LinearRgbTile.y] origin.
void compositeSelectedStreaksInPlace({
  required LinearRgbTile destination,
  required LinearRgbTile foreground,
  Uint8List? foregroundCoverage,
  required List<StreakShape> streaks,
  double paddingPixels = 3,
}) {
  _validate(destination, foreground);
  if (foregroundCoverage != null &&
      foregroundCoverage.length != destination.width * destination.height) {
    throw ArgumentError('Foreground coverage dimensions do not match.');
  }
  if (streaks.isEmpty) {
    throw InvalidStreakCompositeInput(
      'At least one streak must be selected.',
    );
  }
  // Apply directly inside each streak's padded bounding box. Re-applying a
  // foreground pixel where selected streak masks overlap is harmless because
  // per-channel max is idempotent: max(max(a, b), b) == max(a, b).
  // This exactly preserves the old mask-based result while eliminating the
  // temporary Uint8 mask and the subsequent whole-tile scan.
  for (final StreakShape streak in streaks) {
    final ({double x, double y}) a = streak.endpoints[0];
    final ({double x, double y}) b = streak.endpoints[1];
    final double radius = streak.width / 2 + paddingPixels;
    final double radiusSquared = radius * radius;
    final int minX = math.max(
      0,
      (math.min(a.x, b.x) - radius).floor() - destination.x,
    );
    final int maxX = math.min(
      destination.width - 1,
      (math.max(a.x, b.x) + radius).ceil() - destination.x,
    );
    final int minY = math.max(
      0,
      (math.min(a.y, b.y) - radius).floor() - destination.y,
    );
    final int maxY = math.min(
      destination.height - 1,
      (math.max(a.y, b.y) + radius).ceil() - destination.y,
    );
    if (minX > maxX || minY > maxY) continue;
    for (int y = minY; y <= maxY; y++) {
      final double globalY = (destination.y + y).toDouble();
      for (int x = minX; x <= maxX; x++) {
        final double distanceSquared = _squaredDistanceToSegment(
          (destination.x + x).toDouble(),
          globalY,
          a.x,
          a.y,
          b.x,
          b.y,
        );
        if (distanceSquared > radiusSquared) continue;
        if (foregroundCoverage != null &&
            foregroundCoverage[y * destination.width + x] == 0) {
          continue;
        }
        final int base = (y * destination.width + x) * 3;
        destination.interleavedRgb[base] = math.max(
          destination.interleavedRgb[base],
          foreground.interleavedRgb[base],
        );
        destination.interleavedRgb[base + 1] = math.max(
          destination.interleavedRgb[base + 1],
          foreground.interleavedRgb[base + 1],
        );
        destination.interleavedRgb[base + 2] = math.max(
          destination.interleavedRgb[base + 2],
          foreground.interleavedRgb[base + 2],
        );
      }
    }
  }
}
/// Work357: how a selected streak is put onto the background.
/// [lighten] is the historical per-channel max inside the padded mask
/// (default, bit-identical). [additive] adds only the streak's excess over
/// the background (see `tool/raw_samples/meteor_additive_composite_reference
/// .mjs`): no single-frame noise band around the meteor, a feathered edge,
/// and no double counting of a faint meteor residue left in the background.
enum MeteorCompositeBlendMode { lighten, additive }

MeteorCompositeBlendMode meteorCompositeBlendModeFromName(String? name) =>
    MeteorCompositeBlendMode.values.firstWhere(
      (MeteorCompositeBlendMode value) => value.name == name,
      orElse: () => MeteorCompositeBlendMode.lighten,
    );

/// Per-streak sky offset and noise of (foreground - background), estimated in
/// a ring just outside the padded streak mask. [usable] is false when the
/// ring had too few covered samples; additive compositing then leaves the
/// background unchanged for that streak.
final class StreakAdditiveParameters {
  const StreakAdditiveParameters({
    required this.offset,
    required this.sigma,
    required this.samples,
  });

  final List<double> offset;
  final List<double> sigma;
  final int samples;

  bool get usable => samples >= 20 && sigma.every((double s) => s.isFinite);
}

double _medianOf(List<double> values) {
  final List<double> s = <double>[...values]..sort();
  final int n = s.length;
  return n.isOdd ? s[(n - 1) ~/ 2] : (s[n ~/ 2 - 1] + s[n ~/ 2]) / 2;
}

double _smoothstep(double t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/// Estimates [StreakAdditiveParameters] from same-bounds [background] and
/// [foreground] tiles (global origin from the tiles) that cover the streak's
/// padded box plus [ringWidth].
StreakAdditiveParameters estimateStreakAdditiveParameters({
  required LinearRgbTile background,
  required LinearRgbTile foreground,
  Uint8List? foregroundCoverage,
  required StreakShape streak,
  double paddingPixels = 3,
  double ringWidth = 6,
}) {
  _validate(background, foreground);
  final ({double x, double y}) a = streak.endpoints[0];
  final ({double x, double y}) b = streak.endpoints[1];
  final double radius = streak.width / 2 + paddingPixels;
  final List<List<double>> diffs = <List<double>>[
    <double>[],
    <double>[],
    <double>[],
  ];
  for (int y = 0; y < background.height; y++) {
    for (int x = 0; x < background.width; x++) {
      if (foregroundCoverage != null &&
          foregroundCoverage[y * background.width + x] == 0) {
        continue;
      }
      final double d = math.sqrt(_squaredDistanceToSegment(
        (background.x + x).toDouble(),
        (background.y + y).toDouble(),
        a.x,
        a.y,
        b.x,
        b.y,
      ));
      if (d <= radius || d > radius + ringWidth) continue;
      final int base = (y * background.width + x) * 3;
      for (int c = 0; c < 3; c++) {
        diffs[c].add(foreground.interleavedRgb[base + c] -
            background.interleavedRgb[base + c]);
      }
    }
  }
  if (diffs[0].length < 20) {
    return StreakAdditiveParameters(
      offset: const <double>[0, 0, 0],
      sigma: const <double>[
        double.infinity,
        double.infinity,
        double.infinity,
      ],
      samples: diffs[0].length,
    );
  }
  final List<double> offset = <double>[
    for (final List<double> v in diffs) _medianOf(v),
  ];
  final List<double> sigma = <double>[
    for (int c = 0; c < 3; c++)
      math.max(
        1e-9,
        1.4826 *
            _medianOf(<double>[
              for (final double e in diffs[c]) (e - offset[c]).abs(),
            ]),
      ),
  ];
  return StreakAdditiveParameters(
    offset: offset,
    sigma: sigma,
    samples: diffs[0].length,
  );
}

/// Additive counterpart of [compositeSelectedStreaksInPlace]: for each
/// streak (with its global [parameters]), adds the noise-shrunk excess of
/// [foreground] over the current [destination] inside the padded radius,
/// fully within the core (half-width + 1 px) and feathered to zero at the
/// padded radius. Tile-invariant because parameters are global.
void compositeSelectedStreaksAdditiveInPlace({
  required LinearRgbTile destination,
  required LinearRgbTile foreground,
  Uint8List? foregroundCoverage,
  required List<StreakShape> streaks,
  required List<StreakAdditiveParameters> parameters,
  double paddingPixels = 3,
}) {
  _validate(destination, foreground);
  if (streaks.isEmpty || parameters.length != streaks.length) {
    throw InvalidStreakCompositeInput(
      'Additive compositing needs one parameter set per selected streak.',
    );
  }
  for (int s = 0; s < streaks.length; s++) {
    final StreakAdditiveParameters p = parameters[s];
    if (!p.usable) continue;
    final StreakShape streak = streaks[s];
    final ({double x, double y}) a = streak.endpoints[0];
    final ({double x, double y}) b = streak.endpoints[1];
    final double radius = streak.width / 2 + paddingPixels;
    final double core = streak.width / 2 + 1;
    final int minX = math.max(
      0,
      (math.min(a.x, b.x) - radius).floor() - destination.x,
    );
    final int maxX = math.min(
      destination.width - 1,
      (math.max(a.x, b.x) + radius).ceil() - destination.x,
    );
    final int minY = math.max(
      0,
      (math.min(a.y, b.y) - radius).floor() - destination.y,
    );
    final int maxY = math.min(
      destination.height - 1,
      (math.max(a.y, b.y) + radius).ceil() - destination.y,
    );
    if (minX > maxX || minY > maxY) continue;
    for (int y = minY; y <= maxY; y++) {
      for (int x = minX; x <= maxX; x++) {
        if (foregroundCoverage != null &&
            foregroundCoverage[y * destination.width + x] == 0) {
          continue;
        }
        final double d = math.sqrt(_squaredDistanceToSegment(
          (destination.x + x).toDouble(),
          (destination.y + y).toDouble(),
          a.x,
          a.y,
          b.x,
          b.y,
        ));
        if (d > radius) continue;
        final double f = d <= core
            ? 1
            : 1 - _smoothstep((d - core) / math.max(1e-9, radius - core));
        final int base = (y * destination.width + x) * 3;
        for (int c = 0; c < 3; c++) {
          final double e = foreground.interleavedRgb[base + c] -
              destination.interleavedRgb[base + c] -
              p.offset[c];
          final double shrunk =
              e * _smoothstep((e - p.sigma[c]) / (2 * p.sigma[c]));
          destination.interleavedRgb[base + c] =
              destination.interleavedRgb[base + c] + f * shrunk;
        }
      }
    }
  }
}

/// Result of [estimateMeteorRadiant].
final class MeteorRadiantEstimate {
  const MeteorRadiantEstimate({required this.radiant, required this.consistent});

  /// Image-plane radiant (may lie outside the frame), or null when fewer
  /// than the required number of streaks agree.
  final ({double x, double y})? radiant;

  /// Per input streak: whether its line points at [radiant].
  final List<bool> consistent;
}

/// Work357: shower-radiant consistency. A rectilinear projection maps each
/// meteor path to a straight line through the radiant. RANSAC over pairwise
/// line intersections; a streak is consistent when the angle between its
/// line and the direction from its midpoint to the radiant is within
/// [toleranceDegrees]. Satellites and aircraft generally are not.
MeteorRadiantEstimate estimateMeteorRadiant(
  List<StreakShape> streaks, {
  double toleranceDegrees = 3,
  int minConsistent = 3,
}) {
  final List<({double mx, double my, double ux, double uy})> lines =
      <({double mx, double my, double ux, double uy})>[];
  for (final StreakShape s in streaks) {
    final ({double x, double y}) a = s.endpoints[0];
    final ({double x, double y}) b = s.endpoints[1];
    final double dx = b.x - a.x;
    final double dy = b.y - a.y;
    final double l = math.max(1e-12, math.sqrt(dx * dx + dy * dy));
    lines.add((mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ux: dx / l, uy: dy / l));
  }
  final double tol = math.sin(toleranceDegrees * math.pi / 180);
  List<bool> consistentWith(double px, double py) => <bool>[
        for (final ({double mx, double my, double ux, double uy}) l in lines)
          () {
            final double vx = px - l.mx;
            final double vy = py - l.my;
            final double dist = math.sqrt(vx * vx + vy * vy);
            if (dist < 1e-9) return true;
            return (vx * l.uy - vy * l.ux).abs() / dist <= tol;
          }(),
      ];
  ({double x, double y})? best;
  int bestCount = 0;
  for (int i = 0; i < lines.length; i++) {
    for (int j = i + 1; j < lines.length; j++) {
      final ({double mx, double my, double ux, double uy}) p = lines[i];
      final ({double mx, double my, double ux, double uy}) q = lines[j];
      final double den = p.ux * q.uy - p.uy * q.ux;
      if (den.abs() < 1e-6) continue;
      final double t = ((q.mx - p.mx) * q.uy - (q.my - p.my) * q.ux) / den;
      final double px = p.mx + t * p.ux;
      final double py = p.my + t * p.uy;
      final int count = consistentWith(px, py).where((bool v) => v).length;
      if (count > bestCount) {
        bestCount = count;
        best = (x: px, y: py);
      }
    }
  }
  final ({double x, double y})? found = best;
  if (found == null || bestCount < minConsistent) {
    return MeteorRadiantEstimate(
      radiant: null,
      consistent: List<bool>.filled(lines.length, false),
    );
  }
  return MeteorRadiantEstimate(
    radiant: found,
    consistent: consistentWith(found.x, found.y),
  );
}
