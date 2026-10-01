import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/dng_profile_look_table.dart';

void main() {
  test('look table reuses the verified cyclic HSV interpolation kernel', () {
    final DngProfileLookTable table = DngProfileLookTable(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 1,
      encoding: 0,
      deltas: const <double>[0, 1, 1, 120, 1, 1],
    );
    final Float64List output = Float64List(3);
    table.transformPixel(1, 0, 0, output);
    expect(output[0], closeTo(0, 1e-12));
    expect(output[1], closeTo(1, 1e-12));
    expect(output[2], closeTo(0, 1e-12));
  });

  test('look table constructor copies and validates its source', () {
    final List<double> source = <double>[0, 1, 1, 0, 1, 1];
    final DngProfileLookTable table = DngProfileLookTable(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 1,
      encoding: 0,
      deltas: source,
    );
    source[4] = 0;
    final Float64List output = Float64List(3);
    table.transformPixel(1, 0, 0, output);
    expect(output, orderedEquals(<double>[1, 0, 0]));
    expect(
      () => DngProfileLookTable(
        hueDivisions: 1,
        saturationDivisions: 1,
        valueDivisions: 1,
        encoding: 0,
        deltas: const <double>[],
      ),
      throwsArgumentError,
    );
  });
}
