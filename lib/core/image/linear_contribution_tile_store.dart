import '../tiles/overlapped_tile_plan.dart';
import 'linear_contribution_tile.dart';

abstract interface class LinearContributionTileStore {
  int get width;
  int get height;
  int get persistentByteLength;
  int get completedTileCount;
  bool get isCommitted;

  Future<void> writeTile(LinearContributionTile tile);

  Future<LinearContributionTile> readRegion({
    required int x,
    required int y,
    required int width,
    required int height,
  });

  Future<void> commit();
  Future<void> abort();
  Future<void> dispose();
}

typedef LinearContributionTileStoreFactory = Future<LinearContributionTileStore>
    Function({
  required int width,
  required int height,
  required OverlappedTilePlan plan,
});
