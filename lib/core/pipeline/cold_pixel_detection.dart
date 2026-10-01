import '../image/linear_raw_mosaic.dart';
import 'raw_defect_map.dart';

class InvalidColdPixelDetectionInput extends ArgumentError {
  InvalidColdPixelDetectionInput(String super.message);
}

RawDefectMap detectColdPixelsFromMasterFlat(
  LinearRawMosaic masterFlat, {
  int neighborhoodRadius = 5,
  double ratioThreshold = 5,
  double absoluteThreshold = 0,
}) {
  if (neighborhoodRadius < 1) {
    throw InvalidColdPixelDetectionInput(
      'neighborhoodRadius must be a positive integer.',
    );
  }
  if (!ratioThreshold.isFinite || ratioThreshold <= 1) {
    throw InvalidColdPixelDetectionInput(
      'ratioThreshold must be finite and greater than 1.',
    );
  }
  if (!absoluteThreshold.isFinite || absoluteThreshold < 0) {
    throw InvalidColdPixelDetectionInput(
      'absoluteThreshold must be finite and non-negative.',
    );
  }

  final int width = masterFlat.width;
  final int height = masterFlat.height;
  final List<RawDefectPoint> coldPixels = <RawDefectPoint>[];
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      final double ownValue = masterFlat.samples[y * width + x];
      if (!ownValue.isFinite) {
        throw StateError('Master flat contains a non-finite sample.');
      }
      final List<double> neighbors = <double>[];
      final int minY = (y - neighborhoodRadius).clamp(0, height - 1);
      final int maxY = (y + neighborhoodRadius).clamp(0, height - 1);
      final int minX = (x - neighborhoodRadius).clamp(0, width - 1);
      final int maxX = (x + neighborhoodRadius).clamp(0, width - 1);
      for (int neighborY = minY; neighborY <= maxY; neighborY++) {
        for (int neighborX = minX; neighborX <= maxX; neighborX++) {
          if (neighborX == x && neighborY == y) continue;
          if (neighborX.isEven != x.isEven || neighborY.isEven != y.isEven) {
            continue;
          }
          final double value =
              masterFlat.samples[neighborY * width + neighborX];
          if (!value.isFinite) {
            throw StateError('Master flat contains a non-finite sample.');
          }
          neighbors.add(value);
        }
      }
      if (neighbors.isEmpty) continue;
      neighbors.sort();
      final int middle = neighbors.length ~/ 2;
      final double median = neighbors.length.isOdd
          ? neighbors[middle]
          : (neighbors[middle - 1] + neighbors[middle]) * 0.5;
      if (ownValue * ratioThreshold <= median &&
          ownValue <= median - absoluteThreshold) {
        coldPixels.add(RawDefectPoint(x: x, y: y));
      }
    }
  }
  return RawDefectMap(coldPixels);
}
