import 'dart:typed_data';

import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

class RecordingRgbTileStoreFactory {
  RecordingRgbTileStore? latest;
  final List<RecordingRgbTileStore> created = <RecordingRgbTileStore>[];

  Future<LinearRgbTileStore> call({
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) async {
    final RecordingRgbTileStore store = RecordingRgbTileStore(
      width: width,
      height: height,
      expectedTiles: plan.tiles,
    );
    latest = store;
    created.add(store);
    return store;
  }
}

class RecordingRgbTileStore implements LinearRgbTileStore {
  RecordingRgbTileStore({
    required this.width,
    required this.height,
    required List<OverlappedTile> expectedTiles,
  }) : _expectedTiles = expectedTiles;

  final List<OverlappedTile> _expectedTiles;
  final List<LinearRgbTile> writtenTiles = <LinearRgbTile>[];
  bool aborted = false;
  bool disposed = false;

  @override
  final int width;

  @override
  final int height;

  @override
  int get persistentByteLength => width * height * 3 * 4;

  @override
  int get completedTileCount => writtenTiles.length;

  @override
  bool get isCommitted => _isCommitted;
  bool _isCommitted = false;

  @override
  Future<void> writeTile(LinearRgbTile tile) async {
    if (disposed || _isCommitted) throw StateError('Store is not writable.');
    final OverlappedTile expected = _expectedTiles[writtenTiles.length];
    if (tile.x != expected.outputX ||
        tile.y != expected.outputY ||
        tile.width != expected.outputWidth ||
        tile.height != expected.outputHeight) {
      throw StateError('Unexpected tile.');
    }
    writtenTiles.add(tile);
  }

  @override
  Future<void> commit() async {
    if (disposed || writtenTiles.length != _expectedTiles.length) {
      throw StateError('Store is incomplete.');
    }
    _isCommitted = true;
  }

  @override
  Future<LinearRgbTile> readRegion({
    required int x,
    required int y,
    required int width,
    required int height,
  }) async {
    if (disposed) throw StateError('Store is disposed.');
    if (!_isCommitted) throw StateError('Store is not committed.');
    if (x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > this.width ||
        y + height > this.height) {
      throw RangeError('Requested region is outside the store.');
    }

    final Float32List region = Float32List(width * height * 3);
    for (final LinearRgbTile tile in writtenTiles) {
      final int left = x > tile.x ? x : tile.x;
      final int top = y > tile.y ? y : tile.y;
      final int right =
          x + width < tile.x + tile.width ? x + width : tile.x + tile.width;
      final int bottom =
          y + height < tile.y + tile.height ? y + height : tile.y + tile.height;
      if (left >= right || top >= bottom) continue;

      for (int sourceY = top; sourceY < bottom; sourceY++) {
        final int sourceStart =
            ((sourceY - tile.y) * tile.width + left - tile.x) * 3;
        final int destinationStart = ((sourceY - y) * width + left - x) * 3;
        region.setRange(
          destinationStart,
          destinationStart + (right - left) * 3,
          tile.interleavedRgb,
          sourceStart,
        );
      }
    }
    return LinearRgbTile(
      x: x,
      y: y,
      width: width,
      height: height,
      interleavedRgb: region,
    );
  }

  @override
  Future<void> abort() async {
    aborted = true;
    disposed = true;
  }

  @override
  Future<void> dispose() async {
    disposed = true;
  }
}
