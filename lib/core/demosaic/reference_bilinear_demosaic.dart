import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/linear_rgb_tile.dart';
import 'demosaic_algorithm.dart';
import 'demosaic_engine.dart';
import 'demosaic_request.dart';

/// Deterministic FP32 reference implementation used for tests and fallback
/// diagnostics. It is intentionally not presented as the production-quality
/// highest-quality demosaic algorithm.
final class ReferenceBilinearDemosaic implements DemosaicEngine {
  const ReferenceBilinearDemosaic();

  @override
  DemosaicAlgorithm get algorithm => DemosaicAlgorithm.referenceBilinear;

  @override
  bool get isProductionQuality => false;

  @override
  int get requiredInputRadius => 1;

  @override
  Future<LinearRgbTile> processTile(DemosaicRequest request) async {
    request.validate();
    final LinearRawMosaic source = request.mosaic;
    final int outputWidth = request.tile.outputWidth;
    final int outputHeight = request.tile.outputHeight;
    final Float32List output = Float32List(outputWidth * outputHeight * 3);

    for (int localY = 0; localY < outputHeight; localY++) {
      final int y = request.tile.outputY + localY;
      for (int localX = 0; localX < outputWidth; localX++) {
        final int x = request.tile.outputX + localX;
        final int base = (localY * outputWidth + localX) * 3;
        for (final CfaColor target in CfaColor.values) {
          output[base + target.index] = _interpolate(source, x, y, target);
        }
      }
    }

    return LinearRgbTile(
      x: request.tile.outputX,
      y: request.tile.outputY,
      width: outputWidth,
      height: outputHeight,
      interleavedRgb: output,
    );
  }

  double _interpolate(LinearRawMosaic source, int x, int y, CfaColor target) {
    if (source.cfaPattern.colorAt(x, y) == target) {
      return source.sampleAt(x, y);
    }

    double sum = 0;
    int count = 0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        final int px = (x + dx).clamp(0, source.width - 1);
        final int py = (y + dy).clamp(0, source.height - 1);
        if (source.cfaPattern.colorAt(px, py) == target) {
          sum += source.sampleAt(px, py);
          count++;
        }
      }
    }
    return count == 0 ? source.sampleAt(x, y) : sum / count;
  }
}
