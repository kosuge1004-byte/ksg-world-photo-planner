import '../tiles/overlapped_tile_plan.dart';
import 'linear_rgb_tile.dart';

abstract interface class LinearRgbTileStore {
  int get width;
  int get height;
  int get persistentByteLength;
  int get completedTileCount;
  bool get isCommitted;

  Future<void> writeTile(LinearRgbTile tile);

  Future<LinearRgbTile> readRegion({
    required int x,
    required int y,
    required int width,
    required int height,
  });

  Future<void> commit();
  Future<void> abort();
  Future<void> dispose();
}

typedef LinearRgbTileStoreFactory = Future<LinearRgbTileStore> Function({
  required int width,
  required int height,
  required OverlappedTilePlan plan,
});

class LinearRgbTileStoreUnavailable implements Exception {
  const LinearRgbTileStoreUnavailable(this.message);
  final String message;

  @override
  String toString() => message;
}
