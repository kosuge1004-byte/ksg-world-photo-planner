import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/extract_green_luminance_from_mosaic.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_raw_mosaic_store.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';

void main() {
  test('file-backed CFA green extraction matches in-memory extraction',
      () async {
    const int width = 7;
    const int height = 5;
    final Float32List samples = Float32List(width * height);
    for (int i = 0; i < samples.length; i++) {
      samples[i] = (i * 13 + 7) / 11.0;
    }
    final RawSaturationMask mask = RawSaturationMask.fromPredicate(
      width * height,
      (int i) => i == 2 || i == 13 || i == 28,
    );
    final LinearRawMosaic source = LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(samples),
      saturationMask: mask,
    );

    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    await store.writeFull(source);

    try {
      const List<double> phaseScales = <double>[1.0, 1.25, 0.75, 1.5];

      final LinearRawMosaic referenceMosaic = LinearRawMosaic(
        width: width,
        height: height,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(samples),
        saturationMask: mask,
      );
      for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
          final int i = y * width + x;
          referenceMosaic.samples[i] = referenceMosaic.samples[i] *
              phaseScales[((y & 1) << 1) | (x & 1)];
        }
      }
      final expectedGreen = extractGreenLuminanceFromMosaic(referenceMosaic);
      final expectedMask =
          greenLuminanceSaturationInfluenceMask(referenceMosaic);

      final FileBackedGreenLuminanceResult actual =
          await extractGreenLuminanceFromFileBackedMosaic(
        store: store,
        phaseScales: phaseScales,
        rowsPerStrip: 2,
      );

      expect(actual.luminance.samples, orderedEquals(expectedGreen.samples));
      for (int i = 0; i < width * height; i++) {
        expect(
          actual.saturationInfluenceMask?.isSaturatedIndex(i) ?? false,
          expectedMask?.isSaturatedIndex(i) ?? false,
          reason: 'mask pixel $i',
        );
      }
    } finally {
      await store.dispose();
    }
  });
}
