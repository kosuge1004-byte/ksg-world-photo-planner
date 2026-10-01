import 'dart:typed_data';

import '../registration/luminance_plane.dart';

final class FocusAlignedFrame {
  FocusAlignedFrame({
    required this.width,
    required this.height,
    required Float32List interleavedRgb,
    required Uint8List coverage,
  })  : interleavedRgb = interleavedRgb,
        coverage = coverage {
    final int pixels = width * height;
    if (width <= 0 ||
        height <= 0 ||
        interleavedRgb.length != pixels * 3 ||
        coverage.length != pixels) {
      throw ArgumentError(
          'Aligned focus-frame buffers do not match dimensions.');
    }
    for (int pixel = 0; pixel < pixels; pixel++) {
      final int base = pixel * 3;
      if (coverage[pixel] != 0 &&
          (!interleavedRgb[base].isFinite ||
              !interleavedRgb[base + 1].isFinite ||
              !interleavedRgb[base + 2].isFinite)) {
        throw ArgumentError('Covered aligned RGB pixels must be finite.');
      }
    }
  }

  final int width;
  final int height;
  final Float32List interleavedRgb;
  final Uint8List coverage;

  LuminancePlane greenLuminance() {
    final Float32List green = Float32List(width * height);
    for (int pixel = 0; pixel < green.length; pixel++) {
      green[pixel] = coverage[pixel] == 0 ? 0 : interleavedRgb[pixel * 3 + 1];
    }
    return LuminancePlane(width: width, height: height, samples: green);
  }
}
