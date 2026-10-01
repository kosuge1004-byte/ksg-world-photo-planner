import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/dng_profile_hue_sat_map.dart';

void main() {
  test('neutral 2.5D map preserves RGB exactly', () {
    final DngProfileHueSatMap map = DngProfileHueSatMap(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 1,
      encoding: 0,
      deltas: const <double>[0, 1, 1, 0, 1, 1],
    );
    final Float64List output = Float64List(3);
    map.transformPixel(0.8, 0.3, 0.1, output);
    expect(output[0], closeTo(0.8, 1e-12));
    expect(output[1], closeTo(0.3, 1e-12));
    expect(output[2], closeTo(0.1, 1e-12));
  });

  test('saturation-axis interpolation matches Adobe 2.5D reference', () {
    final DngProfileHueSatMap map = DngProfileHueSatMap(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 1,
      encoding: 0,
      // Saturation zero is neutral; saturation one removes saturation.
      deltas: const <double>[0, 1, 1, 0, 0, 1],
    );
    final Float64List output = Float64List(3);
    map.transformPixel(1, 0.5, 0.5, output);
    expect(output[0], closeTo(1, 1e-12));
    expect(output[1], closeTo(0.75, 1e-12));
    expect(output[2], closeTo(0.75, 1e-12));
  });

  test('hue shift uses degrees and wraps cyclically', () {
    final DngProfileHueSatMap map = DngProfileHueSatMap(
      hueDivisions: 2,
      saturationDivisions: 2,
      valueDivisions: 1,
      encoding: 0,
      deltas: const <double>[
        0,
        1,
        1,
        60,
        1,
        1,
        0,
        1,
        1,
        0,
        1,
        1,
      ],
    );
    final Float64List output = Float64List(3);
    map.transformPixel(1, 0, 0, output);
    expect(output[0], closeTo(1, 1e-12));
    expect(output[1], closeTo(1, 1e-12));
    expect(output[2], closeTo(0, 1e-12));
  });

  test('neutral 3D map round-trips SDK overrange encoding', () {
    final DngProfileHueSatMap map = DngProfileHueSatMap(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 2,
      encoding: 1,
      isHighDynamicRange: true,
      deltas: const <double>[
        0,
        1,
        1,
        0,
        1,
        1,
        0,
        1,
        1,
        0,
        1,
        1,
      ],
    );
    final Float64List output = Float64List(3);
    map.transformPixel(4, 1, 0.25, output);
    expect(output[0], closeTo(4, 1e-10));
    expect(output[1], closeTo(1, 1e-10));
    expect(output[2], closeTo(0.25, 1e-10));
  });

  test('3D map defaults to SDR and therefore clips overrange output', () {
    final DngProfileHueSatMap map = DngProfileHueSatMap(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 2,
      encoding: 0,
      deltas: const <double>[
        0,
        1,
        1,
        0,
        1,
        1,
        0,
        1,
        1,
        0,
        1,
        1,
      ],
    );
    final Float64List output = Float64List(3);
    map.transformPixel(4, 1, 0.25, output);
    expect(output[0], 1);
    expect(output[1], closeTo(0.25, 1e-12));
    expect(output[2], closeTo(0.0625, 1e-12));
  });

  test('3D table lookup clamps overrange V instead of extrapolating', () {
    final DngProfileHueSatMap map = DngProfileHueSatMap(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 2,
      encoding: 0,
      deltas: const <double>[
        // V=0 plane: neutral.
        0, 1, 1, 0, 1, 1,
        // V=1 plane: zero saturation stays neutral as required by DNG;
        // saturated colors halve value.
        0, 1, 1, 0, 1, 0.5,
      ],
    );
    final Float64List output = Float64List(3);
    map.transformPixel(4, 0, 0, output);

    // V=4 must select the V=1 edge of the table, not extrapolate four
    // cells beyond it. The scaled SDR result is then clipped to UI white.
    expect(output[0], 1);
    expect(output[1], 0);
    expect(output[2], 0);
  });

  test('constructor copies source and enforces bounded raw-map validation', () {
    final List<double> source = <double>[0, 1, 1, 0, 1, 1];
    final DngProfileHueSatMap map = DngProfileHueSatMap(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 1,
      encoding: 0,
      deltas: source,
    );
    source[4] = 0;
    final Float64List output = Float64List(3);
    map.transformPixel(1, 0, 0, output);
    expect(output, orderedEquals(<double>[1, 0, 0]));
    expect(
      () => DngProfileHueSatMap(
        hueDivisions: 361,
        saturationDivisions: 2,
        valueDivisions: 1,
        encoding: 0,
        deltas: const <double>[],
      ),
      throwsArgumentError,
    );
  });
}
