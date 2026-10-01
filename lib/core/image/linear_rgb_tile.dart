import 'dart:typed_data';

class LinearRgbTile {
  LinearRgbTile({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
    required Float32List interleavedRgb,
  }) : interleavedRgb = interleavedRgb {
    if (x < 0 || y < 0) {
      throw ArgumentError('Tile origin must not be negative.');
    }
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Tile dimensions must be positive.');
    }
    if (interleavedRgb.length != width * height * 3) {
      throw ArgumentError('RGB tile sample count does not match dimensions.');
    }
  }

  final int x;
  final int y;
  final int width;
  final int height;
  final Float32List interleavedRgb;

  int get byteLength => interleavedRgb.lengthInBytes;

  double channelAt(int localX, int localY, int channel) {
    if (localX < 0 || localX >= width) {
      throw RangeError.range(localX, 0, width - 1, 'localX');
    }
    if (localY < 0 || localY >= height) {
      throw RangeError.range(localY, 0, height - 1, 'localY');
    }
    if (channel < 0 || channel > 2) {
      throw RangeError.range(channel, 0, 2, 'channel');
    }
    return interleavedRgb[(localY * width + localX) * 3 + channel];
  }
}
