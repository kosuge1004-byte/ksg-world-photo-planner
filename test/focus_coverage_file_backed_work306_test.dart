import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/focus_stack/file_backed_focus_coverage_mask.dart';

void main() {
  test('file-backed focus coverage writes binary 0/1 as DNG 0/255', () async {
    final FileBackedFocusCoverageMask mask =
        await FileBackedFocusCoverageMask.createTemporary(
      width: 5,
      height: 3,
    );
    try {
      await mask.writeRegion(
        x: 1,
        y: 0,
        width: 3,
        height: 2,
        binaryCoverage: Uint8List.fromList(<int>[
          1,
          0,
          1,
          0,
          1,
          1,
        ]),
      );
      await mask.writeRegion(
        x: 0,
        y: 2,
        width: 5,
        height: 1,
        binaryCoverage: Uint8List.fromList(<int>[1, 1, 0, 0, 1]),
      );
      await mask.commit();

      expect(
        await mask.readRows(startY: 0, rowCount: 3),
        orderedEquals(<int>[
          0,
          255,
          0,
          255,
          0,
          0,
          0,
          255,
          255,
          0,
          255,
          255,
          0,
          0,
          255,
        ]),
      );
    } finally {
      await mask.dispose();
    }
  });
}
