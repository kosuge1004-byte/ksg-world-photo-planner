import '../tiles/overlapped_tile_plan.dart';
import 'float64_rgb_tile.dart';

abstract interface class Float64RgbTileStore {
  int get width;
  int get height;
  int get persistentByteLength;
  int get completedTileCount;
  bool get isCommitted;

  Future<void> writeTile(Float64RgbTile tile);

  Future<Float64RgbTile> readRegion({
    required int x,
    required int y,
    required int width,
    required int height,
  });

  Future<void> commit();
  Future<void> abort();
  Future<void> dispose();
}

typedef Float64RgbTileStoreFactory = Future<Float64RgbTileStore> Function({
  required int width,
  required int height,
  required OverlappedTilePlan plan,
});
