import 'dart:typed_data';
import 'dart:math' as math;

import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'star_trail_gap_fill.dart';

final class _PreparedGapSegment {
  const _PreparedGapSegment({
    required this.points,
    required this.brightness,
    required this.startRgb,
    required this.endRgb,
    required this.left,
    required this.top,
    required this.right,
    required this.bottom,
  });

  final List<(double, double)> points;
  final double brightness;
  final List<double> startRgb, endRgb;
  final double left;
  final double top;
  final double right;
  final double bottom;
}

/// Copies a committed stack into a new tile store while painting gap-fill
/// segments. Committed tile stores are immutable, so this copy-on-write pass
/// preserves their lifecycle contract and holds only one output tile in RAM.
Future<LinearRgbTileStore> createGapFilledStarTrailStore({
  required LinearRgbTileStore source,
  required LinearRgbTileStoreFactory outputStoreFactory,
  required List<GapFillSegment> segments,
  int tileSize = 256,
  double dotRadiusPixels = 1.4,
  bool Function()? isCancelled,
  void Function(int x, int y, int width, int height, Uint8List mask)?
      onSyntheticMask,
}) async {
  if (!source.isCommitted) {
    throw StateError('Gap-fill source must be committed.');
  }
  if (tileSize <= 0 || !dotRadiusPixels.isFinite || dotRadiusPixels <= 0) {
    throw ArgumentError('Invalid gap-fill tile or dot size.');
  }
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: source.width,
    imageHeight: source.height,
    tileSize: tileSize,
    overlap: 0,
  );
  final LinearRgbTileStore output = await outputStoreFactory(
    width: source.width,
    height: source.height,
    plan: plan,
  );
  bool committed = false;
  try {
    final List<_PreparedGapSegment> prepared = <_PreparedGapSegment>[
      for (final GapFillSegment segment in segments)
        await _prepareSegment(source, segment, dotRadiusPixels),
    ];
    for (final OverlappedTile tile in plan.tiles) {
      if (isCancelled?.call() ?? false) {
        throw StateError('Star-trail gap filling was cancelled.');
      }
      final LinearRgbTile region = await source.readRegion(
        x: tile.outputX,
        y: tile.outputY,
        width: tile.outputWidth,
        height: tile.outputHeight,
      );
      final synthetic = Uint8List(region.width * region.height);
      for (final _PreparedGapSegment segment in prepared) {
        if (segment.right < tile.outputX ||
            segment.bottom < tile.outputY ||
            segment.left >= tile.outputX + tile.outputWidth ||
            segment.top >= tile.outputY + tile.outputHeight) {
          continue;
        }
        _paintSegment(region, segment, synthetic,
            dotRadiusPixels: dotRadiusPixels);
      }
      await output.writeTile(region);
      onSyntheticMask?.call(
          region.x, region.y, region.width, region.height, synthetic);
    }
    await output.commit();
    committed = true;
    return output;
  } finally {
    if (!committed) await output.abort();
  }
}

Future<_PreparedGapSegment> _prepareSegment(
  LinearRgbTileStore source,
  GapFillSegment segment,
  double dotRadiusPixels,
) async {
  Future<List<double>> color(double x, double y) async {
    final sample = await source.readRegion(
        x: x.floor().clamp(0, source.width - 1),
        y: y.floor().clamp(0, source.height - 1),
        width: 1,
        height: 1);
    return sample.interleavedRgb.toList();
  }

  final startRgb = await color(segment.startX, segment.startY);
  final endRgb = await color(segment.endX, segment.endY);
  final List<(double, double)> points = <(double, double)>[
    (segment.startX, segment.startY),
    ...segment.samplePoints(),
  ];
  return _PreparedGapSegment(
    points: points,
    brightness: segment.brightness,
    startRgb: startRgb,
    endRgb: endRgb,
    left: points.map((p) => p.$1).reduce(math.min) - dotRadiusPixels,
    top: points.map((p) => p.$2).reduce(math.min) - dotRadiusPixels,
    right: points.map((p) => p.$1).reduce(math.max) + dotRadiusPixels,
    bottom: points.map((p) => p.$2).reduce(math.max) + dotRadiusPixels,
  );
}

void _paintSegment(
  LinearRgbTile region,
  _PreparedGapSegment segment,
  Uint8List synthetic, {
  required double dotRadiusPixels,
}) {
  for (int pointIndex = 0; pointIndex < segment.points.length; pointIndex++) {
    final (double px, double py) = segment.points[pointIndex];
    final t = segment.points.length == 1
        ? 0.0
        : pointIndex / (segment.points.length - 1);
    final rgb = List<double>.generate(
        3,
        (channel) =>
            segment.startRgb[channel] * (1 - t) + segment.endRgb[channel] * t);
    final peak = rgb.reduce(math.max);
    final limit =
        peak > segment.brightness && peak > 0 ? segment.brightness / peak : 1.0;
    final int localMinX =
        (px - dotRadiusPixels - region.x).floor().clamp(0, region.width - 1);
    final int localMaxX =
        (px + dotRadiusPixels - region.x).ceil().clamp(0, region.width - 1);
    final int localMinY =
        (py - dotRadiusPixels - region.y).floor().clamp(0, region.height - 1);
    final int localMaxY =
        (py + dotRadiusPixels - region.y).ceil().clamp(0, region.height - 1);
    for (int y = localMinY; y <= localMaxY; y++) {
      for (int x = localMinX; x <= localMaxX; x++) {
        final double dx = (region.x + x + 0.5) - px;
        final double dy = (region.y + y + 0.5) - py;
        final double distance = math.sqrt(dx * dx + dy * dy);
        if (distance > dotRadiusPixels) continue;
        final falloff = (1 - distance / dotRadiusPixels) * limit;
        final int sampleBase = (y * region.width + x) * 3;
        for (int channel = 0; channel < 3; channel++) {
          final int sampleIndex = sampleBase + channel;
          final value = rgb[channel] * falloff;
          if (value > region.interleavedRgb[sampleIndex]) {
            synthetic[y * region.width + x] = 1;
            region.interleavedRgb[sampleIndex] = value;
          }
        }
      }
    }
  }
}
