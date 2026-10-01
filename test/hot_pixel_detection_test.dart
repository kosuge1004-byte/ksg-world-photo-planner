import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/pipeline/hot_pixel_detection.dart';
import 'package:mobile_stack/core/pipeline/raw_defect_map.dart';

/// Dart port of `tool/raw_samples/test/hot_pixel_detection_
/// reference.test.mjs` (excluding the two type-validation rejection
/// cases: unreachable in Dart — see `hot_pixel_detection.dart`'s own
/// doc comment).

LinearRawMosaic _makeMasterDark(
  int width,
  int height,
  double Function(int x, int y) fill,
) {
  final Float32List samples = Float32List(width * height);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      samples[y * width + x] = fill(x, y);
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
  test('一様なマスターダークではホットピクセルは検出されない', () {
    final LinearRawMosaic dark = _makeMasterDark(
      11,
      11,
      (int x, int y) => 5,
    );
    final RawDefectMap result = detectHotPixelsFromMasterDark(dark);
    expect(result.points, isEmpty);
  });

  test(
    '局所近傍より極端に高い値を持つ画素がホットピクセルとして検出される',
    () {
      final LinearRawMosaic dark = _makeMasterDark(11, 11, (int x, int y) {
        if (x == 5 && y == 5) return 100;
        return 2;
      });
      final RawDefectMap result = detectHotPixelsFromMasterDark(
        dark,
        ratioThreshold: 5,
        absoluteThreshold: 10,
      );
      expect(result.points, hasLength(1));
      expect(result.points.first.x, 5);
      expect(result.points.first.y, 5);
    },
  );

  test(
    '相対閾値・絶対閾値のどちらか片方しか満たさない場合は検出されない'
    '(両方が独立に必要という設計の検証)',
    () {
      final LinearRawMosaic notHot = _makeMasterDark(11, 11, (int x, int y) {
        if (x == 5 && y == 5) return 9;
        return 2;
      });
      expect(
        detectHotPixelsFromMasterDark(
          notHot,
          ratioThreshold: 5,
          absoluteThreshold: 50,
        ).points,
        isEmpty,
      );

      final LinearRawMosaic highBaselineNotHot = _makeMasterDark(
        11,
        11,
        (int x, int y) {
          if (x == 5 && y == 5) return 1500;
          return 1000;
        },
      );
      expect(
        detectHotPixelsFromMasterDark(
          highBaselineNotHot,
          ratioThreshold: 5,
          absoluteThreshold: 50,
        ).points,
        isEmpty,
      );
    },
  );

  test(
    '同じCFA位相の画素だけが近傍として使われる(異なる色は混ざらない)',
    () {
      final LinearRawMosaic dark = _makeMasterDark(11, 11, (int x, int y) {
        if (x == 5 && y == 5) return 3.5;
        final bool isOddOdd = (x % 2 == 1) && (y % 2 == 1);
        return isOddOdd ? 3 : 9999;
      });
      final RawDefectMap result = detectHotPixelsFromMasterDark(
        dark,
        ratioThreshold: 1.1,
        absoluteThreshold: 0.1,
      );
      expect(result.points, hasLength(1));
      expect(result.points.first.x, 5);
      expect(result.points.first.y, 5);
    },
  );

  test('端・角の画素も近傍を画像範囲内にクリップして正しく処理される', () {
    final LinearRawMosaic dark = _makeMasterDark(6, 6, (int x, int y) {
      if (x == 0 && y == 0) return 100;
      return 2;
    });
    final RawDefectMap result = detectHotPixelsFromMasterDark(
      dark,
      ratioThreshold: 5,
      absoluteThreshold: 10,
    );
    expect(result.points, hasLength(1));
    expect(result.points.first.x, 0);
    expect(result.points.first.y, 0);
  });

  test('不正なパラメータを拒否する', () {
    final LinearRawMosaic dark = _makeMasterDark(5, 5, (int x, int y) => 1);
    expect(
      () => detectHotPixelsFromMasterDark(dark, neighborhoodRadius: 0),
      throwsA(isA<InvalidHotPixelDetectionInput>()),
    );
    expect(
      () => detectHotPixelsFromMasterDark(dark, ratioThreshold: 1),
      throwsA(isA<InvalidHotPixelDetectionInput>()),
    );
    expect(
      () => detectHotPixelsFromMasterDark(dark, absoluteThreshold: -1),
      throwsA(isA<InvalidHotPixelDetectionInput>()),
    );
  });
  test('ホットピクセル検出は非有限入力と非有限閾値を拒否する', () {
    final LinearRawMosaic bad = _makeMasterDark(
      5,
      5,
      (int x, int y) => (x == 0 && y == 0) ? double.nan : 1,
    );
    expect(
      () => detectHotPixelsFromMasterDark(bad),
      throwsA(isA<InvalidHotPixelDetectionInput>()),
    );

    final LinearRawMosaic valid = _makeMasterDark(
      5,
      5,
      (int x, int y) => 1,
    );
    expect(
      () => detectHotPixelsFromMasterDark(
        valid,
        ratioThreshold: double.infinity,
      ),
      throwsA(isA<InvalidHotPixelDetectionInput>()),
    );
    expect(
      () => detectHotPixelsFromMasterDark(
        valid,
        absoluteThreshold: double.infinity,
      ),
      throwsA(isA<InvalidHotPixelDetectionInput>()),
    );
  });
}
