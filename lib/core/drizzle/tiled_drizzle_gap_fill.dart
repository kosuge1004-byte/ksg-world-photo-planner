import 'dart:typed_data';

import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'drizzle_gap_fill.dart' show InvalidGapFillInput;

/// Tiled, memory-bounded wrapper around [fillChannelGaps]'s per-channel
/// gap-filling logic (`drizzle_gap_fill.dart`, Work91), reading directly
/// from `drizzleCfaTiled`'s (Work87) own `valueStore`/`coverageStore`
/// output and producing one final, dense [LinearRgbTileStore] — a normal
/// demosaiced-looking RGB image, ready for tone mapping and export, no
/// longer sparse.
///
/// Mirrors the same "read a small margin-expanded region per output
/// tile, process, write just that tile" discipline as every other tiled
/// combiner in this project (`TiledKappaSigmaCombiner`,
/// `TiledAffineRgbResampler`, `tiled_cfa_drizzle.dart` itself) — the
/// margin here is simply [kernelRadius] pixels on every side (the same
/// radius `fillChannelGaps` itself searches), clamped to the image's own
/// valid extent, since gap-filling a pixel near a tile's own edge may
/// need to look at a neighbor that technically belongs to the
/// *adjacent* output tile.
///
/// This function's output store carries only the filled *value* — a
/// plain three-channel [LinearRgbTileStore], matching what a normal
/// demosaiced image looks like for the tone-mapping/export step that
/// follows it. A caller that also needs each channel's filled
/// *coverage* (e.g. to visualize which regions were genuinely well-
/// sampled versus interpolated) should call `fillChannelGaps`/
/// `fillDrizzleResultGaps` (Work91) directly on the whole-image data
/// instead — this tiled wrapper exists specifically for the common
/// "produce a viewable image without exceeding memory" case.
///
/// This file has not been executed against the Dart SDK. Its own new
/// logic — reading a margin-expanded region, delegating to the same
/// gap-fill math `fillChannelGaps` (Work91) already tests, and writing
/// back just the tile-sized portion — has direct test coverage in
/// `test/tiled_drizzle_gap_fill_test.dart`, which additionally confirms
/// this tiled version's output matches whole-image `fillChannelGaps`
/// exactly, the same "tiled version numerically matches the whole-frame
/// version" discipline established for `tiled_cfa_drizzle.dart`
/// (Work87) itself.

/// Fills [valueStore]/[coverageStore]'s gaps tile by tile, writing the
/// result to a store built from [outputStoreFactory].
///
/// - [valueStore], [coverageStore]: `drizzleCfaTiled`'s own output —
///   both must already be committed.
/// - [tileSize]: output tiling granularity, independent of whatever
///   tiling `valueStore`/`coverageStore` themselves used internally
///   (this function only calls their public `readRegion`, not anything
///   tile-plan-specific about them).
/// - [kernelRadius], [minimumCoverage]: as `fillChannelGaps`.
Future<LinearRgbTileStore> fillDrizzleTiledGaps({
  required LinearRgbTileStore valueStore,
  required LinearRgbTileStore coverageStore,
  required LinearRgbTileStoreFactory outputStoreFactory,
  int tileSize = 512,
  int kernelRadius = 2,
  double minimumCoverage = 1e-6,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
}) async {
  if (valueStore.width != coverageStore.width ||
      valueStore.height != coverageStore.height) {
    throw InvalidGapFillInput(
      'valueStore and coverageStore must have matching dimensions.',
    );
  }
  if (kernelRadius < 1) {
    throw InvalidGapFillInput('kernelRadius must be a positive integer.');
  }
  if (!minimumCoverage.isFinite || minimumCoverage <= 0) {
    throw InvalidGapFillInput(
      'minimumCoverage must be finite and positive.',
    );
  }

  final int width = valueStore.width;
  final int height = valueStore.height;
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width,
    imageHeight: height,
    tileSize: tileSize,
    overlap: 0,
  );
  final LinearRgbTileStore outputStore = await outputStoreFactory(
    width: width,
    height: height,
    plan: plan,
  );

  bool committed = false;
  try {
    for (int tileIndex = 0; tileIndex < plan.tiles.length; tileIndex++) {
      if (isCancelled?.call() ?? false) {
        throw StateError('Gap fill was cancelled.');
      }
      final OverlappedTile tile = plan.tiles[tileIndex];
      final int regionX = (tile.outputX - kernelRadius).clamp(0, width - 1);
      final int regionY = (tile.outputY - kernelRadius).clamp(0, height - 1);
      final int regionRight =
          (tile.outputX + tile.outputWidth - 1 + kernelRadius)
              .clamp(0, width - 1);
      final int regionBottom =
          (tile.outputY + tile.outputHeight - 1 + kernelRadius)
              .clamp(0, height - 1);
      final int regionWidth = regionRight - regionX + 1;
      final int regionHeight = regionBottom - regionY + 1;

      final LinearRgbTile valueRegion = await valueStore.readRegion(
        x: regionX,
        y: regionY,
        width: regionWidth,
        height: regionHeight,
      );
      final LinearRgbTile coverageRegion = await coverageStore.readRegion(
        x: regionX,
        y: regionY,
        width: regionWidth,
        height: regionHeight,
      );

      final Float32List outputSamples = Float32List(
        tile.outputWidth * tile.outputHeight * 3,
      );
      // タイル自身の座標系(regionX/Yを原点とする)へのオフセット。
      final int tileOffsetX = tile.outputX - regionX;
      final int tileOffsetY = tile.outputY - regionY;

      for (int c = 0; c < 3; c++) {
        for (int ty = 0; ty < tile.outputHeight; ty++) {
          for (int tx = 0; tx < tile.outputWidth; tx++) {
            // regionLocalX/Y: このタイルの画素が、読み込んだ
            // マージン付きregion(regionX/regionY起点)の中で占める
            // ローカル座標。画像全体の絶対座標ではないことに注意
            // (valueRegion/coverageRegionはregion自身の起点からの
            // ローカルインデックスで格納されている)。
            final int regionLocalX = tileOffsetX + tx;
            final int regionLocalY = tileOffsetY + ty;
            final int regionIndex =
                (regionLocalY * regionWidth + regionLocalX) * 3 + c;
            final double ownCoverage =
                coverageRegion.interleavedRgb[regionIndex];
            double filledValue;
            if (ownCoverage >= minimumCoverage) {
              filledValue = valueRegion.interleavedRgb[regionIndex];
            } else {
              double weightedValueSum = 0;
              double coverageSum = 0;
              final int minY = (regionLocalY - kernelRadius).clamp(
                0,
                regionHeight - 1,
              );
              final int maxY = (regionLocalY + kernelRadius).clamp(
                0,
                regionHeight - 1,
              );
              final int minX = (regionLocalX - kernelRadius).clamp(
                0,
                regionWidth - 1,
              );
              final int maxX = (regionLocalX + kernelRadius).clamp(
                0,
                regionWidth - 1,
              );
              for (int ny = minY; ny <= maxY; ny++) {
                for (int nx = minX; nx <= maxX; nx++) {
                  final int neighborIndex = (ny * regionWidth + nx) * 3 + c;
                  final double neighborCoverage =
                      coverageRegion.interleavedRgb[neighborIndex];
                  if (neighborCoverage < minimumCoverage) continue;
                  weightedValueSum +=
                      valueRegion.interleavedRgb[neighborIndex] *
                          neighborCoverage;
                  coverageSum += neighborCoverage;
                }
              }
              filledValue =
                  coverageSum > 0 ? weightedValueSum / coverageSum : 0;
            }
            outputSamples[(ty * tile.outputWidth + tx) * 3 + c] = filledValue;
          }
        }
      }

      await outputStore.writeTile(
        LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: outputSamples,
        ),
      );
      reportProgress?.call((tileIndex + 1) / plan.tiles.length);
    }
    await outputStore.commit();
    committed = true;
    return outputStore;
  } finally {
    if (!committed) await outputStore.abort();
  }
}
