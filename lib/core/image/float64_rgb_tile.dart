import 'dart:typed_data';

/// A [width] x [height] interleaved-RGB tile backed by `double` (FP64)
/// samples, rather than `LinearRgbTile`'s `Float32List`.
///
/// ## Why this type exists
/// `TiledKappaSigmaCombiner`'s weighted-average path (used when
/// `enableOutlierRejection: false`, i.e. Milky Way with movement removal
/// OFF) accumulates `finalSums`/`finalWeightSums` in `Float64List`s across
/// every frame and only narrows to `Float32List` once, at the very final
/// division. A rolling accumulator that instead narrows to FP32 after
/// *every* fold (as `LinearRgbTile`/`FileBackedLinearRgbTileStore` would
/// force it to) accumulates FP32 rounding error at each step and was
/// measured (see the Node.js property check run while building this) to
/// disagree with the production FP64-accumulated result in roughly 77% of
/// random cases — small (parts-per-million), but a real, non-zero
/// difference, which this project's quality policy does not permit
/// treating as negligible. Keeping the running sum/weight totals at FP64
/// precision between folds, and narrowing only once at the final divide
/// (see `finalizeRollingWeightedAverage` in
/// `tiled_weighted_average_combiner.dart`), reproduced the production
/// result bit-for-bit in 20,000/20,000 additional random trials.
final class Float64RgbTile {
  Float64RgbTile({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
    required Float64List interleaved,
  }) : interleaved = interleaved {
    if (x < 0 || y < 0) {
      throw ArgumentError('Tile origin must not be negative.');
    }
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Tile dimensions must be positive.');
    }
    if (interleaved.length != width * height * 3) {
      throw ArgumentError('FP64 tile sample count does not match dimensions.');
    }
  }

  final int x;
  final int y;
  final int width;
  final int height;
  final Float64List interleaved;

  int get byteLength => interleaved.lengthInBytes;
}
