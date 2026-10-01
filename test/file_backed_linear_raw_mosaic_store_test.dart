import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_raw_mosaic_store.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';

LinearRawMosaic _mosaicWithPixelValues(int width, int height) {
  final Float32List samples = Float32List(width * height);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      samples[y * width + x] = (y * width + x) * 1.5;
    }
  }
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: CfaPattern.rggb,
    samples: samples,
  );
}

void main() {
  test('全画面をRAM化せずファイルへ書いて任意の矩形領域を読み出す', () async {
    const int width = 6;
    const int height = 5;
    final LinearRawMosaic mosaic = _mosaicWithPixelValues(width, height);
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await store.writeFull(mosaic);
      expect(store.isCommitted, isTrue);

      // 任意の(タイル境界に整列していない)矩形領域を読み出せることを
      // 確認する -- これがこのストアを作った目的そのもの。
      final Float32List region = await store.readRegion(
        x: 2,
        y: 1,
        width: 3,
        height: 2,
      );
      expect(region.length, 3 * 2);
      for (int localY = 0; localY < 2; localY++) {
        for (int localX = 0; localX < 3; localX++) {
          final int globalX = 2 + localX;
          final int globalY = 1 + localY;
          final double expected = (globalY * width + globalX) * 1.5;
          expect(region[localY * 3 + localX], expected);
        }
      }

      // 画像全体も1つの領域として読み出せる。
      final Float32List whole = await store.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      for (int i = 0; i < whole.length; i++) {
        expect(whole[i], mosaic.samples[i]);
      }
    } finally {
      await store.dispose();
    }
  });

  test('同じフレームに対して複数回・任意の順序で読み出せる', () async {
    const int width = 4;
    const int height = 4;
    final LinearRawMosaic mosaic = _mosaicWithPixelValues(width, height);
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await store.writeFull(mosaic);
      final Float32List first = await store.readRegion(
        x: 0,
        y: 0,
        width: 2,
        height: 2,
      );
      final Float32List second = await store.readRegion(
        x: 2,
        y: 2,
        width: 2,
        height: 2,
      );
      final Float32List again = await store.readRegion(
        x: 0,
        y: 0,
        width: 2,
        height: 2,
      );
      expect(first, orderedEquals(again));
      expect(first, isNot(orderedEquals(second)));
    } finally {
      await store.dispose();
    }
  });

  test('コミット前の読み出しはStateErrorを投げる', () async {
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: 4,
      height: 4,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await expectLater(
        store.readRegion(x: 0, y: 0, width: 1, height: 1),
        throwsA(isA<StateError>()),
      );
    } finally {
      await store.dispose();
    }
  });

  test('画像範囲外の領域要求はRangeErrorを投げる', () async {
    const int width = 4;
    const int height = 4;
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await store.writeFull(_mosaicWithPixelValues(width, height));
      await expectLater(
        store.readRegion(x: 3, y: 3, width: 2, height: 2),
        throwsA(isA<RangeError>()),
      );
      await expectLater(
        store.readRegion(x: -1, y: 0, width: 2, height: 2),
        throwsA(isA<RangeError>()),
      );
    } finally {
      await store.dispose();
    }
  });

  test('寸法が一致しないモザイクの書き込みはArgumentErrorを投げる', () async {
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: 4,
      height: 4,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await expectLater(
        store.writeFull(_mosaicWithPixelValues(5, 5)),
        throwsA(isA<ArgumentError>()),
      );
    } finally {
      await store.dispose();
    }
  });

  test('read-only view closes without deleting the writer-owned store',
      () async {
    const int width = 4;
    const int height = 3;
    final FileBackedLinearRawMosaicStore owner =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await owner.writeFull(_mosaicWithPixelValues(width, height));
      final FileBackedLinearRawMosaicStore view =
          await FileBackedLinearRawMosaicStore.openReadOnly(
        path: owner.path,
        width: width,
        height: height,
        cfaPattern: CfaPattern.rggb,
        hasSaturationMask: false,
        hasSaturatedPixels: false,
      );
      expect(await view.readRegion(x: 1, y: 1, width: 2, height: 1),
          orderedEquals(<double>[7.5, 9]));
      await view.dispose();
      expect(await File(owner.path).exists(), isTrue);
      expect(await owner.readRegion(x: 1, y: 1, width: 2, height: 1),
          orderedEquals(<double>[7.5, 9]));
    } finally {
      await owner.dispose();
    }
  });

  test(
    'CFAパターンが一致しないモザイクの書き込みはArgumentErrorを投げる',
    () async {
      const int width = 4;
      const int height = 4;
      final FileBackedLinearRawMosaicStore store =
          await FileBackedLinearRawMosaicStore.createTemporary(
        width: width,
        height: height,
        cfaPattern: CfaPattern.rggb,
      );
      try {
        final LinearRawMosaic mismatched = LinearRawMosaic(
          width: width,
          height: height,
          cfaPattern: CfaPattern.bggr,
          samples: Float32List(width * height),
        );
        await expectLater(
          store.writeFull(mismatched),
          throwsA(isA<ArgumentError>()),
        );
      } finally {
        await store.dispose();
      }
    },
  );

  test('コミット後の再書き込みはStateErrorを投げる', () async {
    const int width = 4;
    const int height = 4;
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      await store.writeFull(_mosaicWithPixelValues(width, height));
      await expectLater(
        store.writeFull(_mosaicWithPixelValues(width, height)),
        throwsA(isA<StateError>()),
      );
    } finally {
      await store.dispose();
    }
  });

  test('readFull restores one complete mosaic and its saturation mask',
      () async {
    const int width = 4;
    const int height = 4;
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      final LinearRawMosaic source = _mosaicWithPixelValues(width, height);
      await store.writeFull(source);
      final LinearRawMosaic restored = await store.readFull();
      expect(restored.width, width);
      expect(restored.height, height);
      expect(restored.cfaPattern, CfaPattern.rggb);
      expect(restored.samples, orderedEquals(source.samples));
    } finally {
      await store.dispose();
    }
  });

  test(
    'dispose後は読み書きどちらもStateErrorを投げ、ファイルが削除される',
    () async {
      const int width = 4;
      const int height = 4;
      final FileBackedLinearRawMosaicStore store =
          await FileBackedLinearRawMosaicStore.createTemporary(
        width: width,
        height: height,
        cfaPattern: CfaPattern.rggb,
      );
      await store.writeFull(_mosaicWithPixelValues(width, height));
      final String path = store.path;
      await store.dispose();
      expect(await File(path).exists(), isFalse);
      await expectLater(
        store.readRegion(x: 0, y: 0, width: 1, height: 1),
        throwsA(isA<StateError>()),
      );
      await expectLater(
        store.writeFull(_mosaicWithPixelValues(width, height)),
        throwsA(isA<StateError>()),
      );
    },
  );

  test('disposeは複数回呼んでも安全(冪等)', () async {
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: 4,
      height: 4,
      cfaPattern: CfaPattern.rggb,
    );
    await store.dispose();
    await store.dispose();
  });

  test('非有限サンプルを含むモザイクの書き込みはStateErrorを投げる', () async {
    const int width = 2;
    const int height = 2;
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: width,
      height: height,
      cfaPattern: CfaPattern.rggb,
    );
    try {
      final Float32List samples = Float32List(width * height)..[0] = double.nan;
      final LinearRawMosaic mosaic = LinearRawMosaic(
        width: width,
        height: height,
        cfaPattern: CfaPattern.rggb,
        samples: samples,
      );
      await expectLater(
        store.writeFull(mosaic),
        throwsA(isA<StateError>()),
      );
    } finally {
      await store.dispose();
    }
  });
}
