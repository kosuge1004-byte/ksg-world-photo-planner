import 'dart:typed_data';

import '../image/linear_contribution_tile_store.dart';

final class LinearDngValidityBuildCancelled implements Exception {
  const LinearDngValidityBuildCancelled();

  @override
  String toString() => 'Linear DNG validity-mask construction cancelled.';
}

final class LinearDngValiditySummary {
  const LinearDngValiditySummary({
    required this.validPixelCount,
    required this.invalidPixelCount,
  });

  final int validPixelCount;
  final int invalidPixelCount;

  bool get hasInvalidPixels => invalidPixelCount != 0;
}

/// Produces one byte per output pixel from exact post-rejection contribution
/// counts: 255 = all RGB channels have at least one surviving observation;
/// 0 = one or more channels have no surviving observation.
///
/// Validity is deliberately never inferred from RGB brightness. Linear 0.0 is
/// legitimate image data and must not be confused with an undefined pixel.
Future<Uint8List> buildLinearDngTransparencyMask({
  required LinearContributionTileStore contributionStore,
  int rowsPerRead = 256,
  bool Function()? isCancelled,
}) async {
  if (rowsPerRead <= 0) {
    throw ArgumentError.value(rowsPerRead, 'rowsPerRead', 'must be positive');
  }
  final int width = contributionStore.width;
  final int height = contributionStore.height;
  final Uint8List mask = Uint8List(width * height);

  for (int startY = 0; startY < height; startY += rowsPerRead) {
    if (isCancelled?.call() ?? false) {
      throw const LinearDngValidityBuildCancelled();
    }
    final int rows = (height - startY).clamp(0, rowsPerRead).toInt();
    final tile = await contributionStore.readRegion(
      x: 0,
      y: startY,
      width: width,
      height: rows,
    );
    for (int pixel = 0; pixel < width * rows; pixel++) {
      if ((pixel & 0x3ffff) == 0 && (isCancelled?.call() ?? false)) {
        throw const LinearDngValidityBuildCancelled();
      }
      final int base = pixel * 3;
      final bool valid = tile.interleavedCounts[base] > 0 &&
          tile.interleavedCounts[base + 1] > 0 &&
          tile.interleavedCounts[base + 2] > 0;
      mask[startY * width + pixel] = valid ? 255 : 0;
    }
  }
  return mask;
}

LinearDngValiditySummary summarizeLinearDngTransparencyMask(Uint8List mask) {
  int valid = 0;
  for (final int value in mask) {
    if (value == 255) valid++;
  }
  return LinearDngValiditySummary(
    validPixelCount: valid,
    invalidPixelCount: mask.length - valid,
  );
}
