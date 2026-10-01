import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/focus_stack/focus_photometric_normalization.dart';

/// Work353. Mirrors tool/raw_samples/test/focus_photometric_gain_reference.test.mjs.
void main() {
  test('recovers per-channel gain from paired block means', () {
    final List<List<double>> reference = <List<double>>[
      for (int i = 0; i < 60; i++)
        <double>[0.1 + i * 0.01, 0.08 + i * 0.008, 0.06 + i * 0.006],
    ];
    final List<List<double>> frame = <List<double>>[
      for (final List<double> m in reference)
        <double>[m[0] / 1.06, m[1] / 0.97, m[2] / 1.03],
    ];
    final FocusFrameGain gain = estimateFocusFrameGain(reference, frame);
    expect(gain.applied, isTrue);
    expect(gain.r, closeTo(1.06, 1e-9));
    expect(gain.g, closeTo(0.97, 1e-9));
    expect(gain.b, closeTo(1.03, 1e-9));
  });

  test('dark, clipped, few or implausible blocks fall back to unit gain', () {
    final List<List<double>> dark = <List<double>>[
      for (int i = 0; i < 100; i++) <double>[0.001, 0.001, 0.001],
    ];
    expect(estimateFocusFrameGain(dark, dark).applied, isFalse);
    final List<List<double>> few = <List<double>>[
      for (int i = 0; i < 10; i++) <double>[0.3, 0.3, 0.3],
    ];
    expect(estimateFocusFrameGain(few, few).applied, isFalse);
    final List<List<double>> ref = <List<double>>[
      for (int i = 0; i < 50; i++) <double>[0.6, 0.6, 0.6],
    ];
    final List<List<double>> off = <List<double>>[
      for (int i = 0; i < 50; i++) <double>[0.2, 0.6, 0.6],
    ];
    expect(estimateFocusFrameGain(ref, off).applied, isFalse);
  });

  test('unit gain leaves pixels untouched; applied gain scales channels', () {
    final Float32List rgb = Float32List.fromList(<double>[0.5, 0.25, 0.125]);
    applyFocusFrameGainInPlace(rgb, FocusFrameGain.unit);
    expect(rgb, <double>[0.5, 0.25, 0.125]);
    applyFocusFrameGainInPlace(
      rgb,
      const FocusFrameGain(2, 1, 0.5, applied: true),
    );
    expect(rgb, <double>[1.0, 0.25, 0.0625]);
  });

  test('block centres stay inside the image', () {
    final List<({int x, int y})> centres = focusGainBlockCentres(6000, 4000);
    expect(centres.length, greaterThan(1400));
    for (final ({int x, int y}) c in centres) {
      expect(c.x >= 16 && c.y >= 16 && c.x <= 5984 && c.y <= 3984, isTrue);
    }
  });
}
