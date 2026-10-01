import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/background/focus_marking_background_codec.dart';
import 'package:mobile_stack/core/focus_stack/focus_exact_preview.dart';
import 'package:mobile_stack/core/focus_stack/focus_marking_analysis_pipeline.dart';
import 'package:mobile_stack/core/focus_stack/high_precision_focus_marking.dart';

void main() {
  test('UI復元用マスクをpreview解像度に縮小し選択判定を保持する', () async {
    final Directory directory =
        await Directory.systemTemp.createTemp('focus-codec-test-');
    try {
      final Uint8List fullMask = Uint8List.fromList(<int>[
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
      ]);
      final FocusMarkingAnalysisResult analysis = FocusMarkingAnalysisResult(
        marking: HighPrecisionFocusMarking(
          width: 4,
          height: 4,
          frameCount: 3,
          confidence: Float32List(0),
          frameMasks: <Uint8List>[fullMask, fullMask, fullMask],
          coverageFractions: const <double>[0.125, 0.125, 0.125],
        ),
        exactPreviews: <FocusExactPreview>[
          for (int index = 0; index < 3; index++)
            FocusExactPreview(
              width: 2,
              height: 2,
              luminance8: Uint8List.fromList(<int>[0, 32, 64, 255]),
            ),
        ],
      );
      final String metadataPath =
          '${directory.path}${Platform.pathSeparator}result.json';

      await writeFocusMarkingBackgroundResult(
        path: metadataPath,
        analysis: analysis,
        sourcePaths: const <String>['a', 'b', 'c'],
        referenceIndex: 0,
        showOmissionCandidates: true,
        autoExcludeOmissionCandidates: true,
        outputFormatName: 'jpeg',
        storagePresetName: 'maximum',
      );

      for (int index = 0; index < 3; index++) {
        expect(
          await File(
            '${directory.path}${Platform.pathSeparator}'
            'focus_marking_$index.mask.u8',
          ).length(),
          4,
        );
      }
      final FocusMarkingBackgroundResult restored =
          await readFocusMarkingBackgroundResult(metadataPath);
      expect(restored.analysis.marking.width, 2);
      expect(restored.analysis.marking.height, 2);
      expect(restored.initialSelection, <bool>[false, true, true]);
      expect(restored.omissionCandidates, <bool>[true, true, true]);
      expect(restored.analysis.marking.frameMasks.first, <int>[1, 0, 0, 1]);
    } finally {
      await directory.delete(recursive: true);
    }
  });
}
