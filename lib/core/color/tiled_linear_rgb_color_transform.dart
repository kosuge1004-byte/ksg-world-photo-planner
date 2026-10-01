import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'linear_rgb_color_transform.dart';

class LinearColorTransformCancelled implements Exception {
  const LinearColorTransformCancelled();
}

/// Applies [transform] without materializing the full RGB image in memory.
Future<LinearRgbTileStore> applyLinearRgbColorTransformTiled({
  required LinearRgbTileStore inputStore,
  required LinearRgbTileStoreFactory outputStoreFactory,
  required LinearRgbColorTransform transform,
  int tileSize = 512,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
}) async {
  if (tileSize <= 0) {
    throw ArgumentError.value(tileSize, 'tileSize', 'Must be positive.');
  }
  if (isCancelled?.call() ?? false) {
    throw const LinearColorTransformCancelled();
  }
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: inputStore.width,
    imageHeight: inputStore.height,
    tileSize: tileSize,
    overlap: 0,
  );
  final LinearRgbTileStore outputStore = await outputStoreFactory(
    width: inputStore.width,
    height: inputStore.height,
    plan: plan,
  );
  bool committed = false;
  try {
    for (int index = 0; index < plan.tiles.length; index++) {
      if (isCancelled?.call() ?? false) {
        throw const LinearColorTransformCancelled();
      }
      final OverlappedTile tile = plan.tiles[index];
      final LinearRgbTile input = await inputStore.readRegion(
        x: tile.outputX,
        y: tile.outputY,
        width: tile.outputWidth,
        height: tile.outputHeight,
      );
      await outputStore.writeTile(
        LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: transform.apply(input.interleavedRgb),
        ),
      );
      reportProgress?.call((index + 1) / plan.tiles.length);
    }
    await outputStore.commit();
    committed = true;
    return outputStore;
  } finally {
    if (!committed) await outputStore.abort();
  }
}
