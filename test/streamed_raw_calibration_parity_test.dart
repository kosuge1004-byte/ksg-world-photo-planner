import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/engine/streamed_raw_phase2_executor.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_raw_mosaic_store.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';
import 'package:mobile_stack/core/pipeline/dark_frame_subtraction.dart';
import 'package:mobile_stack/core/pipeline/flat_field_calibration.dart';
import 'package:mobile_stack/core/pipeline/raw_mosaic_calibrator.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';

Future<FileBackedLinearRawMosaicStore> _storeOf(LinearRawMosaic mosaic) async {
  final FileBackedLinearRawMosaicStore store =
      await FileBackedLinearRawMosaicStore.createTemporary(
    width: mosaic.width,
    height: mosaic.height,
    cfaPattern: mosaic.cfaPattern,
  );
  await store.writeFull(mosaic);
  return store;
}

void main() {
  test('streamed RAW calibration matches established in-memory arithmetic',
      () async {
    const int width = 5;
    const int height = 4;
    const CfaPattern cfa = CfaPattern.rggb;
    final Float32List sourceSamples = Float32List.fromList(<double>[
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      6,
      5,
      4,
      3,
      2,
      1,
    ]);
    final RawFrameMetadata metadata = RawFrameMetadata(
      format: RawFormat.arw,
      activeArea: const RawActiveArea(
        left: 0,
        top: 0,
        width: width,
        height: height,
      ),
      orientation: 1,
      blackLevels: const <double>[1, 1.5, 2, 2.5],
      whiteLevel: 15,
      cameraWhiteBalance: const <double>[1.8, 1.0, 1.0, 1.4],
      linearizationTable: <double>[
        for (int i = 0; i < 16; i++) (i * i).toDouble(),
      ],
      blackLevelDeltaH: const <double>[0, 0.1, -0.1, 0.2, 0],
      blackLevelDeltaV: const <double>[0, 0.05, -0.05, 0.1],
    );

    final LinearRawMosaic source = LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: cfa,
      samples: Float32List.fromList(sourceSamples),
    );
    final LinearRawMosaic dark = LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: cfa,
      samples: Float32List.fromList(
        List<double>.generate(width * height, (int i) => 0.1 + (i % 3) * 0.02),
      ),
      saturationMask: RawSaturationMask.fromPredicate(
        width * height,
        (int i) => i == 7,
      ),
    );
    final LinearRawMosaic flat = LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: cfa,
      samples: Float32List.fromList(
        List<double>.generate(
          width * height,
          (int i) => i == 11 ? 0.01 : 0.8 + (i % 5) * 0.1,
        ),
      ),
      saturationMask: RawSaturationMask.fromPredicate(
        width * height,
        (int i) => i == 13,
      ),
    );

    final FileBackedLinearRawMosaicStore inputStore = await _storeOf(source);
    final FileBackedLinearRawMosaicStore darkStore = await _storeOf(dark);
    final FileBackedLinearRawMosaicStore flatStore = await _storeOf(flat);
    StreamedRawCalibrationResult? streamed;
    try {
      streamed = await calibrateStreamedRawToStore(
        input: inputStore,
        metadata: metadata,
        masterDarkStore: darkStore,
        masterFlatStore: flatStore,
        rowChunk: 2,
        isCancelled: () => false,
        reportProgress: (_) {},
      );
      final LinearRawMosaic actual = await streamed.store.readFull();

      LinearRawMosaic expected = LinearRawMosaic(
        width: width,
        height: height,
        cfaPattern: cfa,
        samples: Float32List.fromList(sourceSamples),
      );
      const RawMosaicCalibrator calibrator = RawMosaicCalibrator();
      expect(
        await calibrator.applyLinearizationTable(
          expected,
          table: metadata.linearizationTable!,
        ),
        isTrue,
      );
      expected = LinearRawMosaic(
        width: expected.width,
        height: expected.height,
        cfaPattern: expected.cfaPattern,
        samples: expected.samples,
        saturationMask: RawSaturationMask.fromFiniteFloat32Threshold(
          expected.samples,
          metadata.whiteLevel,
        ),
      );
      expect(
        await calibrator.subtractBlackLevels(
          expected,
          blackLevels: metadata.blackLevels,
          blackLevelDeltaH: metadata.blackLevelDeltaH,
          blackLevelDeltaV: metadata.blackLevelDeltaV,
        ),
        isTrue,
      );
      expected = await subtractDarkFrameFromStoreInPlace(expected, darkStore,
          rowChunk: 2);
      expect(
        await calibrator.normalizeWhiteLevel(
          expected,
          blackLevels: metadata.blackLevels,
          whiteLevel: metadata.whiteLevel,
          blackLevelDeltaH: metadata.blackLevelDeltaH,
          blackLevelDeltaV: metadata.blackLevelDeltaV,
        ),
        isTrue,
      );
      expect(
        await calibrator.applyCameraWhiteBalance(
          expected,
          gains: metadata.cameraWhiteBalance!,
        ),
        isTrue,
      );
      expected = await applyFlatFieldCorrectionFromStoreInPlace(
        expected,
        flatStore,
        rowChunk: 2,
      );

      expect(actual.samples, orderedEquals(expected.samples));
      for (int i = 0; i < width * height; i++) {
        expect(
          actual.saturationMask?.isSaturatedIndex(i) ?? false,
          expected.saturationMask?.isSaturatedIndex(i) ?? false,
          reason: 'mask mismatch at pixel $i',
        );
      }
    } finally {
      await streamed?.store.dispose();
      await flatStore.dispose();
      await darkStore.dispose();
      await inputStore.dispose();
    }
  });
}
