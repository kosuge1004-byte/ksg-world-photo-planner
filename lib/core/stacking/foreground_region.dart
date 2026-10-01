import 'dart:math' as math;
import 'dart:typed_data';

import '../image/linear_rgb_tile.dart';

/// Explicit foreground polygons in the normalized, decoded reference grid.
/// No brightness/color heuristic is permitted to turn an unmarked sky pixel
/// into foreground. Feathering happens inside the selected region only.
final class ForegroundRegion {
  ForegroundRegion(List<List<({double x, double y})>> polygons)
      : polygons = List.unmodifiable(
            polygons.map((p) => List<({double x, double y})>.unmodifiable(p))) {
    if (polygons.isEmpty || polygons.length > 64) {
      throw ArgumentError('Select a foreground region.');
    }
    for (final polygon in polygons) {
      if (polygon.length < 3 ||
          polygon.length > 512 ||
          polygon.any((p) =>
              !p.x.isFinite ||
              !p.y.isFinite ||
              p.x < 0 ||
              p.x > 1 ||
              p.y < 0 ||
              p.y > 1)) {
        throw ArgumentError('Invalid normalized foreground polygon.');
      }
      double area = 0;
      for (int i = 0; i < polygon.length; i++) {
        final a = polygon[i], b = polygon[(i + 1) % polygon.length];
        area += a.x * b.y - b.x * a.y;
      }
      if (area.abs() < 1e-12) {
        throw ArgumentError('Foreground polygon has no area.');
      }
    }
  }
  final List<List<({double x, double y})>> polygons;
  List<Object> toJson() => polygons
      .map((polygon) => polygon.map((p) => [p.x, p.y]).toList())
      .toList();
  factory ForegroundRegion.fromJson(Object value) =>
      ForegroundRegion((value as List)
          .map((polygon) => (polygon as List)
              .map((point) => (
                    x: ((point as List)[0] as num).toDouble(),
                    y: (point[1] as num).toDouble()
                  ))
              .toList())
          .toList());

  Float32List weights(LinearRgbTile tile, int imageWidth, int imageHeight,
      {double featherPixels = 4}) {
    if (imageWidth <= 0 ||
        imageHeight <= 0 ||
        !featherPixels.isFinite ||
        featherPixels <= 0) {
      throw ArgumentError('Invalid foreground grid/feather width.');
    }
    final out = Float32List(tile.width * tile.height);
    for (final polygon in polygons) {
      final points = polygon
          .map((p) => (x: p.x * imageWidth, y: p.y * imageHeight))
          .toList();
      final minX =
          math.max(tile.x, points.map((p) => p.x).reduce(math.min).floor());
      final maxX = math.min(tile.x + tile.width - 1,
          points.map((p) => p.x).reduce(math.max).ceil());
      final minY =
          math.max(tile.y, points.map((p) => p.y).reduce(math.min).floor());
      final maxY = math.min(tile.y + tile.height - 1,
          points.map((p) => p.y).reduce(math.max).ceil());
      for (int y = minY; y <= maxY; y++) {
        for (int x = minX; x <= maxX; x++) {
          final px = x + .5, py = y + .5;
          bool inside = false;
          double distance = double.infinity;
          for (int i = 0; i < points.length; i++) {
            final a = points[i], b = points[(i + 1) % points.length];
            if ((a.y > py) != (b.y > py) &&
                px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x) {
              inside = !inside;
            }
            final dx = b.x - a.x, dy = b.y - a.y;
            final lengthSquared = dx * dx + dy * dy;
            final t = lengthSquared == 0
                ? 0.0
                : (((px - a.x) * dx + (py - a.y) * dy) / lengthSquared)
                    .clamp(0.0, 1.0);
            distance = math.min(
                distance,
                math.sqrt(math.pow(px - a.x - t * dx, 2) +
                    math.pow(py - a.y - t * dy, 2)));
          }
          if (!inside) continue;
          final t = (distance / featherPixels).clamp(0.0, 1.0);
          final index = (y - tile.y) * tile.width + x - tile.x;
          out[index] = math.max(out[index], t * t * (3 - 2 * t));
        }
      }
    }
    return out;
  }
}
