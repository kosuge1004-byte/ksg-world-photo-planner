import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/focus_stack/high_precision_focus_marking.dart';
import 'package:mobile_stack/core/registration/luminance_plane.dart';

void main() {
  test('score-stage API is exactly equivalent to the combined wrapper', () {
    LuminancePlane plane(double offset) => LuminancePlane(
          width: 7,
          height: 7,
          samples: Float32List.fromList(<double>[
            for (int y = 0; y < 7; y++)
              for (int x = 0; x < 7; x++)
                offset + (x < 3 ? x * 0.05 : 0.8 + y * 0.03),
          ]),
        );

    final List<LuminancePlane> luminance = <LuminancePlane>[
      plane(0),
      plane(0.02),
    ];
    final HighPrecisionFocusMarking wrapped =
        buildHighPrecisionFocusMarking(alignedLuminance: luminance);
    final List<Float32List> scores = <Float32List>[
      for (final LuminancePlane frame in luminance)
        buildHighPrecisionFocusFrameScore(alignedLuminance: frame),
    ];
    final HighPrecisionFocusMarking staged =
        buildHighPrecisionFocusMarkingFromScores(
      width: 7,
      height: 7,
      combinedScores: scores,
      validMasks: const <Uint8List?>[null, null],
    );

    expect(staged.confidence, orderedEquals(wrapped.confidence));
    expect(staged.frameMasks[0], orderedEquals(wrapped.frameMasks[0]));
    expect(staged.frameMasks[1], orderedEquals(wrapped.frameMasks[1]));
    expect(staged.coverageFractions, orderedEquals(wrapped.coverageFractions));
  });

  test('winner selection preserves first-frame ties and overlap semantics', () {
    final HighPrecisionFocusMarking marking =
        buildHighPrecisionFocusMarkingFromScores(
      width: 3,
      height: 1,
      combinedScores: <Float32List>[
        Float32List.fromList(<double>[10, 8, 1]),
        Float32List.fromList(<double>[5, 8, 4]),
      ],
      validMasks: const <Uint8List?>[null, null],
    );

    expect(marking.confidence[0], closeTo(0.5, 1e-7));
    expect(marking.confidence[1], 0);
    expect(marking.confidence[2], closeTo(0.75, 1e-7));
    expect(marking.frameMasks[0], orderedEquals(<int>[1, 0, 0]));
    expect(marking.frameMasks[1], orderedEquals(<int>[0, 1, 1]));
    expect(marking.coverageFractions[0], closeTo(1 / 3, 1e-12));
    expect(marking.coverageFractions[1], closeTo(2 / 3, 1e-12));
  });

  test('file-backed frame scoring is bit-exact to in-memory scoring', () async {
    final LuminancePlane luminance = LuminancePlane(
      width: 9,
      height: 7,
      samples: Float32List.fromList(<double>[
        for (int y = 0; y < 7; y++)
          for (int x = 0; x < 9; x++) (x * x + y * 3) / 100,
      ]),
    );
    final Uint8List mask = Uint8List(9 * 7)..fillRange(0, 9 * 7, 1);
    mask[0] = 0;
    mask[17] = 0;

    final Float32List inMemory = buildHighPrecisionFocusFrameScore(
      alignedLuminance: luminance,
      validMask: mask,
    );
    final Float32List fileBacked =
        await buildHighPrecisionFocusFrameScoreFileBacked(
      alignedLuminance: luminance,
      validMask: mask,
      fusionChunkPixels: 11,
    );

    expect(fileBacked, orderedEquals(inMemory));
  });

  test('file-backed final marking is bit-exact to in-memory marking', () async {
    final List<Float32List> scores = <Float32List>[
      Float32List.fromList(<double>[0, 10, 8, 1, 5, 2, 9, 0, 4, 7, 3, 6]),
      Float32List.fromList(<double>[0, 5, 8, 4, 6, 2, 3, 0, 5, 7, 2, 8]),
      Float32List.fromList(<double>[0, 6, 2, 3, 7, 2, 5, 0, 4, 1, 9, 7]),
    ];
    final List<Uint8List?> masks = <Uint8List?>[
      Uint8List.fromList(<int>[1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1]),
      null,
      Uint8List.fromList(<int>[1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1]),
    ];
    final HighPrecisionFocusMarking expected =
        buildHighPrecisionFocusMarkingFromScores(
      width: 4,
      height: 3,
      combinedScores: scores,
      validMasks: masks,
    );
    final Directory directory =
        await Directory.systemTemp.createTemp('focus_marking_files_test_');
    try {
      final List<File> files = <File>[];
      for (int frame = 0; frame < scores.length; frame++) {
        final File file = File('${directory.path}/frame-$frame.f32');
        await file.writeAsBytes(scores[frame].buffer.asUint8List());
        files.add(file);
      }
      final HighPrecisionFocusMarking actual =
          await buildHighPrecisionFocusMarkingFromScoreFiles(
        width: 4,
        height: 3,
        combinedScoreFiles: files,
        validMasks: masks,
        chunkPixels: 5,
      );
      expect(actual.confidence, orderedEquals(expected.confidence));
      for (int frame = 0; frame < scores.length; frame++) {
        expect(actual.frameMasks[frame],
            orderedEquals(expected.frameMasks[frame]));
      }
      expect(
        actual.coverageFractions,
        orderedEquals(expected.coverageFractions),
      );
    } finally {
      await directory.delete(recursive: true);
    }
  });

  test('file-backed coverage masks are exactly equivalent to resident masks',
      () async {
    final List<Float32List> scores = <Float32List>[
      Float32List.fromList(<double>[4, 1, 8, 3, 6, 2, 9, 5]),
      Float32List.fromList(<double>[2, 7, 4, 8, 3, 6, 1, 9]),
      Float32List.fromList(<double>[1, 5, 3, 4, 8, 7, 6, 2]),
    ];
    final List<Uint8List?> masks = <Uint8List?>[
      null,
      Uint8List.fromList(<int>[1, 1, 0, 1, 1, 1, 0, 1]),
      Uint8List.fromList(<int>[1, 0, 1, 1, 0, 1, 1, 1]),
    ];
    final Directory directory =
        await Directory.systemTemp.createTemp('focus_marking_mask_files_test_');
    try {
      final List<File> scoreFiles = <File>[];
      for (int frame = 0; frame < scores.length; frame++) {
        final File scoreFile = File('${directory.path}/score-$frame.f32');
        await scoreFile.writeAsBytes(scores[frame].buffer.asUint8List());
        scoreFiles.add(scoreFile);
      }
      final List<File?> maskFiles = <File?>[null];
      for (int frame = 1; frame < masks.length; frame++) {
        final File maskFile = File('${directory.path}/mask-$frame.u8');
        await maskFile.writeAsBytes(masks[frame]!);
        maskFiles.add(maskFile);
      }

      final HighPrecisionFocusMarking resident =
          await buildHighPrecisionFocusMarkingFromScoreFiles(
        width: 4,
        height: 2,
        combinedScoreFiles: scoreFiles,
        validMasks: masks,
        chunkPixels: 3,
      );
      final HighPrecisionFocusMarking fileBacked =
          await buildHighPrecisionFocusMarkingFromScoreFiles(
        width: 4,
        height: 2,
        combinedScoreFiles: scoreFiles,
        validMaskFiles: maskFiles,
        chunkPixels: 3,
      );

      expect(fileBacked.confidence, orderedEquals(resident.confidence));
      for (int frame = 0; frame < scores.length; frame++) {
        expect(
          fileBacked.frameMasks[frame],
          orderedEquals(resident.frameMasks[frame]),
        );
      }
      expect(
        fileBacked.coverageFractions,
        orderedEquals(resident.coverageFractions),
      );
    } finally {
      await directory.delete(recursive: true);
    }
  });
}
