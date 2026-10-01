import 'dart:math' as math;
import 'dart:typed_data';

import '../tiles/overlapped_tile_plan.dart';
import 'linear_rgb_tile.dart';
import 'linear_rgb_tile_store.dart';

class LinearRgbDownscaleCancelled implements Exception {
  const LinearRgbDownscaleCancelled();
}

/// Creates one smaller, file-backed source store before registration. Doing
/// this once avoids paying full-resolution registration/stacking cost on every
/// later pass. Level 5/4/3 never call this function.
Future<LinearRgbTileStore> downscaleLinearRgbStore({
  required LinearRgbTileStore source,
  required double linearScale,
  required LinearRgbTileStoreFactory outputStoreFactory,
  int tileSize = 512,
  bool Function()? isCancelled,
}) async {
  if (!linearScale.isFinite || linearScale <= 0 || linearScale >= 1) {
    throw ArgumentError.value(linearScale, 'linearScale');
  }
  final int outputWidth = math.max(1, (source.width * linearScale).round());
  final int outputHeight = math.max(1, (source.height * linearScale).round());
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: outputWidth,
    imageHeight: outputHeight,
    tileSize: tileSize,
    overlap: 0,
  );
  final LinearRgbTileStore output = await outputStoreFactory(
    width: outputWidth,
    height: outputHeight,
    plan: plan,
  );
  try {
    for (final OverlappedTile tile in plan.tiles) {
      if (isCancelled?.call() ?? false) {
        throw const LinearRgbDownscaleCancelled();
      }
      final double firstSourceX = (tile.outputX + 0.5) / linearScale - 0.5;
      final double firstSourceY = (tile.outputY + 0.5) / linearScale - 0.5;
      final double lastSourceX =
          (tile.outputX + tile.outputWidth - 0.5) / linearScale - 0.5;
      final double lastSourceY =
          (tile.outputY + tile.outputHeight - 0.5) / linearScale - 0.5;
      final int sourceX = firstSourceX.floor().clamp(0, source.width - 1);
      final int sourceY = firstSourceY.floor().clamp(0, source.height - 1);
      final int sourceRight =
          (lastSourceX.ceil() + 1).clamp(sourceX + 1, source.width);
      final int sourceBottom =
          (lastSourceY.ceil() + 1).clamp(sourceY + 1, source.height);
      final LinearRgbTile input = await source.readRegion(
        x: sourceX,
        y: sourceY,
        width: sourceRight - sourceX,
        height: sourceBottom - sourceY,
      );
      final Float32List rgb =
          Float32List(tile.outputWidth * tile.outputHeight * 3);
      for (int localY = 0; localY < tile.outputHeight; localY++) {
        final int outputY = tile.outputY + localY;
        final double sy = (outputY + 0.5) / linearScale - 0.5;
        final int y0 = sy.floor().clamp(0, source.height - 1);
        final int y1 = math.min(y0 + 1, source.height - 1);
        final double fy = (sy - y0).clamp(0.0, 1.0);
        for (int localX = 0; localX < tile.outputWidth; localX++) {
          final int outputX = tile.outputX + localX;
          final double sx = (outputX + 0.5) / linearScale - 0.5;
          final int x0 = sx.floor().clamp(0, source.width - 1);
          final int x1 = math.min(x0 + 1, source.width - 1);
          final double fx = (sx - x0).clamp(0.0, 1.0);
          final int p00 = ((y0 - sourceY) * input.width + x0 - sourceX) * 3;
          final int p10 = ((y0 - sourceY) * input.width + x1 - sourceX) * 3;
          final int p01 = ((y1 - sourceY) * input.width + x0 - sourceX) * 3;
          final int p11 = ((y1 - sourceY) * input.width + x1 - sourceX) * 3;
          final int destination = (localY * tile.outputWidth + localX) * 3;
          for (int channel = 0; channel < 3; channel++) {
            final double top = input.interleavedRgb[p00 + channel] * (1 - fx) +
                input.interleavedRgb[p10 + channel] * fx;
            final double bottom =
                input.interleavedRgb[p01 + channel] * (1 - fx) +
                    input.interleavedRgb[p11 + channel] * fx;
            rgb[destination + channel] = top * (1 - fy) + bottom * fy;
          }
        }
      }
      await output.writeTile(LinearRgbTile(
        x: tile.outputX,
        y: tile.outputY,
        width: tile.outputWidth,
        height: tile.outputHeight,
        interleavedRgb: rgb,
      ));
    }
    await output.commit();
    return output;
  } catch (_) {
    await output.abort();
    await output.dispose();
    rethrow;
  }
}
