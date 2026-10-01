import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_raw_mosaic_store.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';
import 'package:mobile_stack/core/pipeline/dark_frame_subtraction.dart';
import 'package:mobile_stack/core/pipeline/flat_field_calibration.dart';

LinearRawMosaic mosaic(
  int width,
  int height,
  List<double> values, {
  RawSaturationMask? mask,
}) =>
    LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(values),
      saturationMask: mask,
    );

void main() {
  test('file-backed dark subtraction matches in-memory in-place result',
      () async {
    const int width = 4;
    const int height = 3;
    final RawSaturationMask darkMask = RawSaturationMask.fromPredicate(
      width * height,
      (int index) => index == 5,
    );
    final LinearRawMosaic dark = mosaic(
      width,
      height,
      List<double>.generate(width * height, (int i) => i + 1.0),
      mask: darkMask,
    );
    final LinearRawMosaic expectedLight = mosaic(
      width,
      height,
      List<double>.generate(width * height, (int i) => 100 + i.toDouble()),
    );
    final LinearRawMosaic actualLight = mosaic(
      width,
      height,
      List<double>.from(expectedLight.samples),
    );
    final LinearRawMosaic expected =
        subtractDarkFrameInPlace(expectedLight, dark);

    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await store.writeFull(dark);
      final LinearRawMosaic actual = await subtractDarkFrameFromStoreInPlace(
        actualLight,
        store,
        rowChunk: 2,
      );
      expect(actual.samples, orderedEquals(expected.samples));
      for (int i = 0; i < width * height; i++) {
        expect(
          actual.saturationMask?.isSaturatedIndex(i) ?? false,
          expected.saturationMask?.isSaturatedIndex(i) ?? false,
        );
      }
    } finally {
      await store.dispose();
    }
  });

  test('file-backed flat correction matches in-memory in-place result',
      () async {
    const int width = 4;
    const int height = 3;
    final RawSaturationMask flatMask = RawSaturationMask.fromPredicate(
      width * height,
      (int index) => index == 7,
    );
    final LinearRawMosaic flat = mosaic(
      width,
      height,
      <double>[1, 0.5, 2, 1, 1, 0.01, 1.5, 1, 1, 2, 0.75, 1],
      mask: flatMask,
    );
    final LinearRawMosaic expectedLight = mosaic(
      width,
      height,
      List<double>.generate(width * height, (int i) => 200 + i.toDouble()),
    );
    final LinearRawMosaic actualLight = mosaic(
      width,
      height,
      List<double>.from(expectedLight.samples),
    );
    final LinearRawMosaic expected =
        applyFlatFieldCorrectionInPlace(expectedLight, flat);

    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await store.writeFull(flat);
      final LinearRawMosaic actual =
          await applyFlatFieldCorrectionFromStoreInPlace(
        actualLight,
        store,
        rowChunk: 2,
      );
      expect(actual.samples, orderedEquals(expected.samples));
      for (int i = 0; i < width * height; i++) {
        expect(
          actual.saturationMask?.isSaturatedIndex(i) ?? false,
          expected.saturationMask?.isSaturatedIndex(i) ?? false,
        );
      }
    } finally {
      await store.dispose();
    }
  });
}
