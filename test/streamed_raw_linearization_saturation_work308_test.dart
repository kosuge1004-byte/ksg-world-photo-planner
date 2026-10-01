import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/engine/streamed_raw_phase2_executor.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_raw_mosaic_store.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';

void main() {
  test('streamed saturation threshold is evaluated after linearization',
      () async {
    const int width = 2;
    const int height = 2;
    final LinearRawMosaic source = LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[4, 5, 6, 7]),
    );
    final FileBackedLinearRawMosaicStore input =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    await input.writeFull(source);

    final RawFrameMetadata metadata = RawFrameMetadata(
      format: RawFormat.arw,
      activeArea: RawActiveArea(
        left: 0,
        top: 0,
        width: width,
        height: height,
      ),
      orientation: 1,
      blackLevels: <double>[0, 0, 0, 0],
      whiteLevel: 10,
      cameraWhiteBalance: <double>[1, 1, 1, 1],
      linearizationTable: <double>[
        0,
        1,
        2,
        3,
        9,
        10,
        11,
        12,
      ],
    );

    StreamedRawCalibrationResult? result;
    try {
      result = await calibrateStreamedRawToStore(
        input: input,
        metadata: metadata,
        masterDarkStore: null,
        masterFlatStore: null,
        rowChunk: 2,
        isCancelled: () => false,
        reportProgress: (_) {},
      );
      expect(result.saturationMask?.isSaturatedIndex(0) ?? false, isFalse);
      expect(result.saturationMask?.isSaturatedIndex(1) ?? false, isTrue);
      expect(result.saturationMask?.isSaturatedIndex(2) ?? false, isTrue);
      expect(result.saturationMask?.isSaturatedIndex(3) ?? false, isTrue);
    } finally {
      await result?.store.dispose();
      await input.dispose();
    }
  });
}
