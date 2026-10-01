import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';
import 'package:mobile_stack/core/pipeline/flat_field_calibration.dart';

/// Dart port of `tool/raw_samples/test/flat_field_calibration_
/// reference.test.mjs` (excluding the "sample count doesn't match
/// dimensions" rejection case: unreachable in Dart — see
/// `flat_field_calibration.dart`'s own doc comment).

LinearRawMosaic _makeMosaic(
  int width,
  int height,
  CfaPattern pattern,
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
    cfaPattern: pattern,
    samples: samples,
  );
}

void main() {
  test('一様なフラットフレームのマスターフラットは全画素1.0になる', () {
    final LinearRawMosaic flat = _makeMosaic(
      3,
      3,
      CfaPattern.rggb,
      (int x, int y) => 500,
    );
    final LinearRawMosaic master = computeMasterFlat(<LinearRawMosaic>[flat]);
    for (final double value in master.samples) {
      expect((value - 1).abs(), lessThan(1e-9));
    }
  });

  test(
    'CFA各色で共通の周辺減光勾配は、色比を変えず位置依存ゲインとして残る',
    () {
      final LinearRawMosaic flat = _makeMosaic(
        4,
        2,
        CfaPattern.rggb,
        (int x, int y) => x < 2 ? 60 : 100,
      );
      final LinearRawMosaic master = computeMasterFlat(<LinearRawMosaic>[
        flat,
      ]);
      for (int y = 0; y < 2; y++) {
        for (int x = 0; x < 4; x++) {
          final double expected = x < 2 ? 0.75 : 1.25;
          expect(
            (master.samples[y * 4 + x] - expected).abs(),
            lessThan(1e-6),
          );
        }
      }
    },
  );

  test(
    '一様照明でもR/G/B感度差があるCFA flatは各色1.0へ正規化され、色かぶりを注入しない',
    () {
      final LinearRawMosaic flat = _makeMosaic(
        4,
        4,
        CfaPattern.rggb,
        (int x, int y) {
          final bool evenX = x.isEven;
          final bool evenY = y.isEven;
          if (evenX && evenY) return 200;
          if (!evenX && !evenY) return 50;
          return 100;
        },
      );
      final LinearRawMosaic master = computeMasterFlat(<LinearRawMosaic>[
        flat,
      ]);
      for (final double value in master.samples) {
        expect((value - 1).abs(), lessThan(1e-9));
      }
    },
  );

  test(
    '中央値は塵の混入のような外れ値スパイクを平均より頑健に無視する'
    '(この設計選択そのものの検証)',
    () {
      const int width = 3;
      const int height = 3;
      const int spikeIndex = 4;
      final List<LinearRawMosaic> flats = <LinearRawMosaic>[];
      for (final double value in <double>[98, 100, 100, 102]) {
        flats.add(
          _makeMosaic(width, height, CfaPattern.rggb, (int x, int y) {
            final int index = y * width + x;
            return index == spikeIndex ? value : 100;
          }),
        );
      }
      flats.add(
        _makeMosaic(width, height, CfaPattern.rggb, (int x, int y) {
          final int index = y * width + x;
          return index == spikeIndex ? 1 : 100;
        }),
      );

      final LinearRawMosaic master = computeMasterFlat(flats);
      expect((master.samples[spikeIndex] - 1).abs(), lessThan(0.02));
    },
  );

  test('マスターフラットで除算すると周辺減光が補正される', () {
    const int width = 3;
    const int height = 1;
    final LinearRawMosaic master = _makeMosaic(
      width,
      height,
      CfaPattern.rggb,
      (int x, int y) => (x == 1) ? 1.5 : 0.75,
    );
    final LinearRawMosaic light = _makeMosaic(
      width,
      height,
      CfaPattern.rggb,
      (int x, int y) => 300,
    );
    final LinearRawMosaic result = applyFlatFieldCorrection(light, master);
    expect((result.samples[1] - 200).abs(), lessThan(1e-6));
    expect((result.samples[0] - 400).abs(), lessThan(1e-6));
  });

  test(
    'マスターフラットの値がminimumFlatValue以下の位置は除算せずそのまま'
    '通す',
    () {
      const int width = 2;
      const int height = 1;
      final LinearRawMosaic master = _makeMosaic(
        width,
        height,
        CfaPattern.rggb,
        (int x, int y) => (x == 0) ? 0.01 : 1,
      );
      final LinearRawMosaic light = _makeMosaic(
        width,
        height,
        CfaPattern.rggb,
        (int x, int y) => 300,
      );
      final LinearRawMosaic result = applyFlatFieldCorrection(
        light,
        master,
        minimumFlatValue: 0.05,
      );
      expect(result.samples[0], 300);
      expect(result.samples[1], 300);
    },
  );

  test('元のlightMosaicは変更されない(新しいオブジェクトを返す)', () {
    const int width = 2;
    const int height = 2;
    final LinearRawMosaic master = _makeMosaic(
      width,
      height,
      CfaPattern.rggb,
      (int x, int y) => 0.9,
    );
    final LinearRawMosaic light = _makeMosaic(
      width,
      height,
      CfaPattern.rggb,
      (int x, int y) => 50,
    );
    final Float32List originalSamples = Float32List.fromList(light.samples);
    applyFlatFieldCorrection(light, master);
    expect(light.samples, orderedEquals(originalSamples));
  });

  test('空のフラットフレーム配列はInvalidFlatFrameInputを投げる', () {
    expect(
      () => computeMasterFlat(const <LinearRawMosaic>[]),
      throwsA(isA<InvalidFlatFrameInput>()),
    );
  });

  test('信号が全くゼロのフラットフレームはInvalidFlatFrameInputを投げる', () {
    final LinearRawMosaic flat = _makeMosaic(
      2,
      2,
      CfaPattern.rggb,
      (int x, int y) => 0,
    );
    expect(
      () => computeMasterFlat(<LinearRawMosaic>[flat]),
      throwsA(isA<InvalidFlatFrameInput>()),
    );
  });

  test('寸法が異なるフラットフレーム同士はInvalidFlatFrameInputを投げる', () {
    final LinearRawMosaic a = _makeMosaic(
      3,
      3,
      CfaPattern.rggb,
      (int x, int y) => 100,
    );
    final LinearRawMosaic b = _makeMosaic(
      4,
      4,
      CfaPattern.rggb,
      (int x, int y) => 100,
    );
    expect(
      () => computeMasterFlat(<LinearRawMosaic>[a, b]),
      throwsA(isA<InvalidFlatFrameInput>()),
    );
  });

  test(
    'CFAパターンが異なるフラットフレーム同士はInvalidFlatFrameInputを'
    '投げる',
    () {
      final LinearRawMosaic a = _makeMosaic(
        3,
        3,
        CfaPattern.rggb,
        (int x, int y) => 100,
      );
      final LinearRawMosaic b = _makeMosaic(
        3,
        3,
        CfaPattern.bggr,
        (int x, int y) => 100,
      );
      expect(
        () => computeMasterFlat(<LinearRawMosaic>[a, b]),
        throwsA(isA<InvalidFlatFrameInput>()),
      );
    },
  );

  test(
    'light/masterの寸法・CFAパターン不一致はInvalidFlatFrameInputを'
    '投げる',
    () {
      final LinearRawMosaic light = _makeMosaic(
        3,
        3,
        CfaPattern.rggb,
        (int x, int y) => 100,
      );
      final LinearRawMosaic wrongSize = _makeMosaic(
        4,
        4,
        CfaPattern.rggb,
        (int x, int y) => 1,
      );
      expect(
        () => applyFlatFieldCorrection(light, wrongSize),
        throwsA(isA<InvalidFlatFrameInput>()),
      );
      final LinearRawMosaic wrongPattern = _makeMosaic(
        3,
        3,
        CfaPattern.bggr,
        (int x, int y) => 1,
      );
      expect(
        () => applyFlatFieldCorrection(light, wrongPattern),
        throwsA(isA<InvalidFlatFrameInput>()),
      );
    },
  );
  test('マスターフラット作成はNaN/Inf入力を中央値処理前に拒否する', () {
    final LinearRawMosaic valid = _makeMosaic(
      2,
      2,
      CfaPattern.rggb,
      (int x, int y) => 100,
    );
    final LinearRawMosaic nanFlat = _makeMosaic(
      2,
      2,
      CfaPattern.rggb,
      (int x, int y) => (x == 0 && y == 0) ? double.nan : 100,
    );
    final LinearRawMosaic infFlat = _makeMosaic(
      2,
      2,
      CfaPattern.rggb,
      (int x, int y) => (x == 1 && y == 0) ? double.infinity : 100,
    );
    expect(
      () => computeMasterFlat(<LinearRawMosaic>[valid, nanFlat]),
      throwsA(isA<InvalidFlatFrameInput>()),
    );
    expect(
      () => computeMasterFlat(<LinearRawMosaic>[valid, infFlat]),
      throwsA(isA<InvalidFlatFrameInput>()),
    );
  });

  test('フラット補正は非有限入力と不正minimumFlatValueを拒否する', () {
    final LinearRawMosaic light = _makeMosaic(
      2,
      2,
      CfaPattern.rggb,
      (int x, int y) => 100,
    );
    final LinearRawMosaic master = _makeMosaic(
      2,
      2,
      CfaPattern.rggb,
      (int x, int y) => 1,
    );
    expect(
      () => applyFlatFieldCorrection(
        light,
        master,
        minimumFlatValue: double.nan,
      ),
      throwsA(isA<InvalidFlatFrameInput>()),
    );
    expect(
      () => applyFlatFieldCorrection(
        light,
        master,
        minimumFlatValue: -0.1,
      ),
      throwsA(isA<InvalidFlatFrameInput>()),
    );
  });

  test('センサー飽和したflat観測はpixel中央値から除外される', () {
    LinearRawMosaic build(double first, bool saturated) {
      final Float32List samples = Float32List.fromList(<double>[
        first,
        100,
        100,
        100,
        100,
        100,
        100,
        100,
        100,
        100,
        100,
        100,
        100,
        100,
        100,
        100,
      ]);
      return LinearRawMosaic(
        width: 4,
        height: 4,
        cfaPattern: CfaPattern.rggb,
        samples: samples,
        saturationMask: RawSaturationMask.fromPredicate(
          16,
          (int index) => saturated && index == 0,
        ),
      );
    }

    final LinearRawMosaic master = computeMasterFlat(<LinearRawMosaic>[
      build(10000, true),
      build(100, false),
      build(100, false),
    ]);
    expect((master.samples[0] - 1).abs(), lessThan(1e-9));
  });

  test('全flatが同一pixelで飽和している場合はinvalidとして保持する', () {
    LinearRawMosaic build() => LinearRawMosaic(
          width: 2,
          height: 2,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List.fromList(<double>[100, 100, 100, 100]),
          saturationMask: RawSaturationMask.fromPredicate(
            4,
            (int index) => index == 0,
          ),
        );

    final LinearRawMosaic master =
        computeMasterFlat(<LinearRawMosaic>[build(), build()]);
    expect(master.samples[0], 1);
    expect(master.saturationMask?.isSaturatedIndex(0), isTrue);
  });

  test('minimumFlatValue以下は素通ししつつinvalidを後段へ伝える', () {
    final LinearRawMosaic light = _makeMosaic(
      2,
      2,
      CfaPattern.rggb,
      (int x, int y) => 300,
    );
    final LinearRawMosaic master = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[0.01, 1, 1, 1]),
    );
    final LinearRawMosaic result = applyFlatFieldCorrection(
      light,
      master,
      minimumFlatValue: 0.05,
    );
    expect(result.samples[0], 300);
    expect(result.saturationMask?.isSaturatedIndex(0), isTrue);
    expect(result.saturationMask?.isSaturatedIndex(1), isFalse);
  });
}
