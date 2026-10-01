import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/stacking/star_trail_reference_foreground_protection.dart';

LinearRgbTile _uniformTile(int width, int height, double value) =>
    LinearRgbTile(
      x: 0,
      y: 0,
      width: width,
      height: height,
      interleavedRgb: Float32List.fromList(
        List<double>.filled(width * height * 3, value),
      ),
    );

void main() {
  test('keeps a thin bright stellar trail', () {
    final LinearRgbTile reference = _uniformTile(16, 16, 0.05);
    final LinearRgbTile combined = _uniformTile(16, 16, 0.05);
    for (int y = 0; y < 16; y++) {
      final int base = (y * 16 + 7) * 3;
      combined.interleavedRgb[base] = 1;
      combined.interleavedRgb[base + 1] = 1;
      combined.interleavedRgb[base + 2] = 1;
    }

    preserveReferenceAgainstBroadTransientBrightening(
      combined: combined,
      reference: reference,
      foregroundWeights: Float32List.fromList(List.filled(256, 1)),
    );

    for (int y = 0; y < 16; y++) {
      final int base = (y * 16 + 7) * 3;
      expect(combined.interleavedRgb[base], closeTo(1, 1e-6));
    }
  });

  test('restores broad transient illumination to the reference', () {
    final LinearRgbTile reference = _uniformTile(16, 16, 0.05);
    final LinearRgbTile combined = _uniformTile(16, 16, 0.30);

    preserveReferenceAgainstBroadTransientBrightening(
      combined: combined,
      reference: reference,
      foregroundWeights: Float32List.fromList(List.filled(256, 1)),
    );

    for (final double value in combined.interleavedRgb) {
      expect(value, closeTo(0.05, 1e-6));
    }
  });

  test(
      'fails open when sparse brightening never reaches the neighborhood threshold',
      () {
    final LinearRgbTile reference = _uniformTile(16, 16, 0.05);
    final LinearRgbTile combined = _uniformTile(16, 16, 0.05);
    for (int y = 0; y < 3; y++) {
      for (int x = 0; x < 16; x++) {
        final int base = (y * 16 + x) * 3;
        combined.interleavedRgb[base] = 0.5;
        combined.interleavedRgb[base + 1] = 0.5;
        combined.interleavedRgb[base + 2] = 0.5;
      }
    }

    preserveReferenceAgainstBroadTransientBrightening(
      combined: combined,
      reference: reference,
      foregroundWeights: Float32List.fromList(List.filled(256, 1)),
    );

    expect(combined.interleavedRgb.first, closeTo(0.5, 1e-6));
  });
}
