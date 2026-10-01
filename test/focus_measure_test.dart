import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/focus_stack/focus_depth_order.dart';
import 'package:mobile_stack/core/focus_stack/focus_measure.dart';
import 'package:mobile_stack/core/focus_stack/focus_measure_file_selection.dart';
import 'package:mobile_stack/core/focus_stack/focus_winner_map.dart';
import 'package:mobile_stack/core/registration/luminance_plane.dart';

void main() {
  test('modified Laplacian scores a sharp edge above a flat field', () {
    final flat = LuminancePlane(
      width: 7,
      height: 7,
      samples: Float32List.fromList(List<double>.filled(49, 0.5)),
    );
    final edgeSamples = <double>[
      for (int y = 0; y < 7; y++)
        for (int x = 0; x < 7; x++)
          if (x < 3) 0 else 1,
    ];
    final edge = LuminancePlane(
      width: 7,
      height: 7,
      samples: Float32List.fromList(edgeSamples),
    );
    final a = modifiedLaplacianFocusMeasure(flat, supportRadius: 1);
    final b = modifiedLaplacianFocusMeasure(edge, supportRadius: 1);
    expect(a.scoreAt(3, 3), 0);
    expect(b.scoreAt(3, 3), greaterThan(0));
  });

  test('winner map reports ambiguity when focus scores tie', () {
    FocusMeasurePlane plane(List<double> values) => FocusMeasurePlane(
          width: 2,
          height: 1,
          scores: Float32List.fromList(values),
        );
    final map = selectFocusWinners(<FocusMeasurePlane>[
      plane(<double>[2, 1]),
      plane(<double>[1, 1]),
    ]);
    expect(map.frameIndices[0], 0);
    expect(map.confidence[0], closeTo(0.5, 1e-6));
    expect(map.confidence[1], 0);
  });
  test('invalid coverage border does not create a false focus response', () {
    final LuminancePlane plane = LuminancePlane(
      width: 7,
      height: 7,
      samples: Float32List.fromList(<double>[
        for (int y = 0; y < 7; y++)
          for (int x = 0; x < 7; x++) x < 3 ? 0 : 1,
      ]),
    );
    final Uint8List mask = Uint8List.fromList(<int>[
      for (int y = 0; y < 7; y++)
        for (int x = 0; x < 7; x++) x < 3 ? 0 : 1,
    ]);
    final FocusMeasurePlane measure = modifiedLaplacianFocusMeasure(
      plane,
      supportRadius: 1,
      validMask: mask,
    );
    expect(measure.scoreAt(3, 3), 0);
  });

  test('file-backed integral rows are bit-exact and remove sidecars', () async {
    final LuminancePlane plane = LuminancePlane(
      width: 11,
      height: 9,
      samples: Float32List.fromList(<double>[
        for (int y = 0; y < 9; y++)
          for (int x = 0; x < 11; x++)
            ((x * x + 3 * y * y + 5 * x * y) % 37) / 37,
      ]),
    );
    final Uint8List mask = Uint8List(11 * 9)..fillRange(0, 11 * 9, 1);
    mask[0] = 0;
    mask[37] = 0;
    mask[98] = 0;
    final Directory directory =
        await Directory.systemTemp.createTemp('focus_measure_test_');
    try {
      for (final int radius in <int>[0, 1, 2, 4]) {
        final File output = File('${directory.path}/radius-$radius.f32');
        await writeModifiedLaplacianFocusMeasureFile(
          luminance: plane,
          supportRadius: radius,
          outputFile: output,
          validMask: mask,
        );
        final Uint8List bytes = await output.readAsBytes();
        final Float32List actual = Float32List.view(
          bytes.buffer,
          bytes.offsetInBytes,
          bytes.lengthInBytes ~/ Float32List.bytesPerElement,
        );
        final FocusMeasurePlane expected = modifiedLaplacianFocusMeasure(
          plane,
          supportRadius: radius,
          validMask: mask,
        );
        expect(actual, orderedEquals(expected.scores));
        expect(File('${output.path}.sum.f64').existsSync(), isFalse);
        expect(File('${output.path}.valid.i32').existsSync(), isFalse);
      }
    } finally {
      await directory.delete(recursive: true);
    }
  });

  test('memory-bounded focus measure is bit-exact', () async {
    final LuminancePlane plane = LuminancePlane(
      width: 13,
      height: 7,
      samples: Float32List.fromList(<double>[
        for (int y = 0; y < 7; y++)
          for (int x = 0; x < 13; x++)
            ((7 * x * x + 11 * y + 3 * x * y) % 43) / 43,
      ]),
    );
    final Uint8List mask = Uint8List(13 * 7)..fillRange(0, 13 * 7, 1);
    mask[0] = 0;
    mask[41] = 0;
    mask[90] = 0;
    final FocusMeasurePlane expected = modifiedLaplacianFocusMeasure(
      plane,
      supportRadius: 2,
      validMask: mask,
    );
    final FocusMeasurePlane actual =
        await computeModifiedLaplacianFocusMeasureMemoryBounded(
      plane,
      supportRadius: 2,
      validMask: mask,
    );
    expect(actual.scores, orderedEquals(expected.scores));
  });

  test('file-backed winner selection and order refinement are bit-exact',
      () async {
    FocusMeasurePlane plane(List<double> scores) => FocusMeasurePlane(
          width: 4,
          height: 2,
          scores: Float32List.fromList(scores),
        );
    final List<FocusMeasurePlane> measures = <FocusMeasurePlane>[
      plane(<double>[3, 1, 2, 4, 1, 7, 2, 3]),
      plane(<double>[2, 4, 2, 3, 5, 6, 3, 2]),
      plane(<double>[1, 3, 5, 2, 4, 2, 7, 1]),
    ];
    final FocusWinnerMap expected = enforceLocalFocusOrderConsistency(
      selectFocusWinners(measures),
      measures,
    );
    final Directory directory =
        await Directory.systemTemp.createTemp('focus_winner_files_');
    try {
      final List<File> files = <File>[];
      for (int frame = 0; frame < measures.length; frame++) {
        final File file = File('${directory.path}/measure-$frame.f32');
        await file.writeAsBytes(
          measures[frame].scores.buffer.asUint8List(),
          flush: true,
        );
        files.add(file);
      }
      final FocusWinnerMap actual = await selectAndRefineFocusWinnersFromFiles(
        width: 4,
        height: 2,
        measureFiles: files,
        chunkPixels: 3,
      );
      expect(actual.frameIndices, orderedEquals(expected.frameIndices));
      expect(actual.confidence, orderedEquals(expected.confidence));
    } finally {
      await directory.delete(recursive: true);
    }
  });
}
