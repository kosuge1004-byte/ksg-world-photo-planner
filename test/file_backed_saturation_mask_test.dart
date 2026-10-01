import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_raw_mosaic_store.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';

void main() {
  test('persists and tile-reads a packed saturation mask exactly', () async {
    const int width = 13;
    const int height = 4;
    final Set<int> saturated = <int>{0, 7, 8, 14, 25, 26, 38, 51};
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List(width * height),
      saturationMask: RawSaturationMask.fromPredicate(
        width * height,
        saturated.contains,
      ),
    );
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await store.writeFull(mosaic);
      expect(store.hasSaturationMask, isTrue);
      expect(
        store.persistentByteLength,
        width * height * Float32List.bytesPerElement +
            ((width * height + 7) >> 3),
      );

      final RawSaturationMask? region = await store.readSaturationRegion(
        x: 5,
        y: 1,
        width: 7,
        height: 3,
      );
      expect(region, isNotNull);
      for (int localY = 0; localY < 3; localY++) {
        for (int localX = 0; localX < 7; localX++) {
          final int globalIndex = (localY + 1) * width + localX + 5;
          expect(
            region!.isSaturatedIndex(localY * 7 + localX),
            saturated.contains(globalIndex),
          );
        }
      }
    } finally {
      await store.dispose();
    }
  });

  test('legacy source store returns no saturation mask', () async {
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await store.writeFull(
        LinearRawMosaic(
          width: 2,
          height: 2,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List(4),
        ),
      );
      expect(store.hasSaturationMask, isFalse);
      expect(
        await store.readSaturationRegion(x: 0, y: 0, width: 2, height: 2),
        isNull,
      );
    } finally {
      await store.dispose();
    }
  });

  test('dispose removes the raw mosaic and saturation sidecar', () async {
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
    );
    final String mosaicPath = store.path;
    final String saturationPath = '$mosaicPath.sat';
    await store.writeFull(
      LinearRawMosaic(
        width: 2,
        height: 2,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List(4),
        saturationMask: RawSaturationMask.fromPredicate(
          4,
          (int index) => index == 2,
        ),
      ),
    );

    expect(await File(mosaicPath).exists(), isTrue);
    expect(await File(saturationPath).exists(), isTrue);
    await store.dispose();
    expect(await File(mosaicPath).exists(), isFalse);
    expect(await File(saturationPath).exists(), isFalse);
  });
}
