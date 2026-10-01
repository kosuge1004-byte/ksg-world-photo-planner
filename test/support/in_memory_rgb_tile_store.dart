import 'dart:typed_data';

import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';

final class RgbReadRequest {
  const RgbReadRequest({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
  });

  final int x;
  final int y;
  final int width;
  final int height;
}

/// Read-only test store with real bounded-region behavior.
final class InMemoryRgbTileStore implements LinearRgbTileStore {
  InMemoryRgbTileStore({
    required this.width,
    required this.height,
    required Float32List interleavedRgb,
  }) : _buffer = Float32List.fromList(interleavedRgb) {
    if (width <= 0 ||
        height <= 0 ||
        interleavedRgb.length != width * height * 3) {
      throw ArgumentError('Invalid in-memory RGB dimensions.');
    }
  }

  @override
  final int width;

  @override
  final int height;

  final Float32List _buffer;
  final List<RgbReadRequest> readRequests = <RgbReadRequest>[];
  bool _isDisposed = false;

  @override
  int get persistentByteLength => _buffer.lengthInBytes;

  @override
  int get completedTileCount => 1;

  @override
  bool get isCommitted => !_isDisposed;

  @override
  Future<LinearRgbTile> readRegion({
    required int x,
    required int y,
    required int width,
    required int height,
  }) async {
    if (_isDisposed) throw StateError('Test RGB store is disposed.');
    if (x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > this.width ||
        y + height > this.height) {
      throw RangeError('Requested test RGB region is outside the image.');
    }
    readRequests.add(RgbReadRequest(x: x, y: y, width: width, height: height));
    final Float32List output = Float32List(width * height * 3);
    for (int row = 0; row < height; row++) {
      final int sourceStart = ((y + row) * this.width + x) * 3;
      final int destinationStart = row * width * 3;
      output.setRange(
        destinationStart,
        destinationStart + width * 3,
        _buffer,
        sourceStart,
      );
    }
    return LinearRgbTile(
      x: x,
      y: y,
      width: width,
      height: height,
      interleavedRgb: output,
    );
  }

  @override
  Future<void> writeTile(LinearRgbTile tile) =>
      throw UnsupportedError('Test RGB store is read-only.');

  @override
  Future<void> commit() async {}

  @override
  Future<void> abort() => dispose();

  @override
  Future<void> dispose() async {
    _isDisposed = true;
  }
}
