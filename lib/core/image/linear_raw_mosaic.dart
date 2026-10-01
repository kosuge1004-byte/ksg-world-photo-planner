import 'dart:typed_data';

import 'cfa_pattern.dart';
import 'raw_saturation_mask.dart';

class LinearRawMosaic {
  LinearRawMosaic({
    required this.width,
    required this.height,
    required this.cfaPattern,
    required Float32List samples,
    this.saturationMask,
  }) : samples = samples {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Image dimensions must be positive.');
    }
    if (samples.length != width * height) {
      throw ArgumentError('Mosaic sample count does not match dimensions.');
    }
    if (saturationMask != null &&
        saturationMask!.pixelCount != width * height) {
      throw ArgumentError('Saturation mask count does not match dimensions.');
    }
  }

  final int width;
  final int height;
  final CfaPattern cfaPattern;
  final Float32List samples;
  final RawSaturationMask? saturationMask;

  double sampleAt(int x, int y) {
    final int safeX = x.clamp(0, width - 1);
    final int safeY = y.clamp(0, height - 1);
    return samples[safeY * width + safeX];
  }

  bool isSaturatedAt(int x, int y) {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      throw RangeError('Saturation coordinate is outside the mosaic.');
    }
    return saturationMask?.isSaturatedIndex(y * width + x) ?? false;
  }
}
