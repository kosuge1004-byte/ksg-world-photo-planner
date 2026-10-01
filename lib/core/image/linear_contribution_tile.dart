import 'dart:typed_data';

/// Per-RGB-channel count of surviving observations after rejection stacking.
final class LinearContributionTile {
  LinearContributionTile({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
    required Uint16List interleavedCounts,
  }) : interleavedCounts = interleavedCounts {
    if (x < 0 || y < 0 || width <= 0 || height <= 0) {
      throw ArgumentError('Contribution tile coordinates are invalid.');
    }
    if (interleavedCounts.length != width * height * 3) {
      throw ArgumentError('Contribution tile sample count is invalid.');
    }
  }

  final int x;
  final int y;
  final int width;
  final int height;
  final Uint16List interleavedCounts;

  int channelCountAt(int localX, int localY, int channel) {
    if (localX < 0 || localX >= width || localY < 0 || localY >= height) {
      throw RangeError('Contribution coordinate is outside the tile.');
    }
    if (channel < 0 || channel > 2) {
      throw RangeError.range(channel, 0, 2, 'channel');
    }
    return interleavedCounts[(localY * width + localX) * 3 + channel];
  }
}
