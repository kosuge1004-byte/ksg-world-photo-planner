import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';
import 'package:mobile_stack/core/pipeline/dark_frame_subtraction.dart';

/// Dart port of `tool/raw_samples/test/dark_frame_subtraction_
/// reference.test.mjs` (excluding the "sample count doesn't match
/// dimensions" rejection case: unreachable in Dart, since
/// [LinearRawMosaic]'s own constructor already enforces that
/// consistency — see `dark_frame_subtraction.dart`'s own doc comment).

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
  test('単一ダークフレームのマスターダークはそのフレーム自身と一致する', () {
    final LinearRawMosaic dark = _makeMosaic(
      3,
      3,
      CfaPattern.rggb,
      (int x, int y) => (x + y * 10).toDouble(),
    );
    final LinearRawMosaic master = computeMasterDark(<LinearRawMosaic>[dark]);
    expect(master.samples, orderedEquals(dark.samples));
  });

  test('奇数枚では中央値がそのまま採用される', () {
    final List<LinearRawMosaic> darks = <LinearRawMosaic>[
      _makeMosaic(2, 2, CfaPattern.rggb, (int x, int y) => 10),
      _makeMosaic(2, 2, CfaPattern.rggb, (int x, int y) => 20),
      _makeMosaic(2, 2, CfaPattern.rggb, (int x, int y) => 30),
    ];
    final LinearRawMosaic master = computeMasterDark(darks);
    expect(master.samples.every((double v) => v == 20), isTrue);
  });

  test('偶数枚では中央2値の平均になる', () {
    final List<LinearRawMosaic> darks = <LinearRawMosaic>[
      _makeMosaic(2, 2, CfaPattern.rggb, (int x, int y) => 10),
      _makeMosaic(2, 2, CfaPattern.rggb, (int x, int y) => 20),
      _makeMosaic(2, 2, CfaPattern.rggb, (int x, int y) => 30),
      _makeMosaic(2, 2, CfaPattern.rggb, (int x, int y) => 40),
    ];
    final LinearRawMosaic master = computeMasterDark(darks);
    expect(master.samples.every((double v) => v == 25), isTrue);
  });

  test(
    '中央値は宇宙線ヒットのような外れ値スパイクを平均より頑健に無視する'
    '(この設計選択そのものの検証)',
    () {
      const int width = 3;
      const int height = 3;
      const int spikeIndex = 4; // 中央画素
      final List<LinearRawMosaic> darks = <LinearRawMosaic>[];
      for (final double value in <double>[4, 5, 5, 6]) {
        darks.add(
          _makeMosaic(width, height, CfaPattern.rggb, (int x, int y) {
            final int index = y * width + x;
            return index == spikeIndex ? value : 3;
          }),
        );
      }
      darks.add(
        _makeMosaic(width, height, CfaPattern.rggb, (int x, int y) {
          final int index = y * width + x;
          return index == spikeIndex ? 5000 : 3;
        }),
      );

      final LinearRawMosaic master = computeMasterDark(darks);
      expect(master.samples[spikeIndex], 5);
      expect(master.samples[0], 3);
    },
  );

  test('マスターダークを減算すると固定パターンが除去される', () {
    const int width = 4;
    const int height = 4;
    final LinearRawMosaic master = _makeMosaic(
      width,
      height,
      CfaPattern.rggb,
      (int x, int y) => (x == 1 && y == 1) ? 50 : 2,
    );
    final LinearRawMosaic light = _makeMosaic(
      width,
      height,
      CfaPattern.rggb,
      (int x, int y) => (x == 1 && y == 1) ? 150 : 12,
    );
    final LinearRawMosaic result = subtractDarkFrame(light, master);
    expect(result.samples[1 * width + 1], 100);
    expect(result.samples[0], 10);
  });

  test('減算結果が負になる位置も線形残差として保持される', () {
    const int width = 2;
    const int height = 2;
    final LinearRawMosaic master = _makeMosaic(
      width,
      height,
      CfaPattern.rggb,
      (int x, int y) => 10,
    );
    final LinearRawMosaic light = _makeMosaic(
      width,
      height,
      CfaPattern.rggb,
      (int x, int y) => 3,
    );
    final LinearRawMosaic result = subtractDarkFrame(light, master);
    expect(result.samples.every((double v) => v == -7), isTrue);
  });

  test('ダーク減算で非有限値が発生した場合は黙って伝播させない', () {
    final LinearRawMosaic master = LinearRawMosaic(
      width: 1,
      height: 1,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[double.infinity]),
    );
    final LinearRawMosaic light = LinearRawMosaic(
      width: 1,
      height: 1,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[1]),
    );
    expect(
      () => subtractDarkFrame(light, master),
      throwsA(isA<InvalidDarkFrameInput>()),
    );
  });

  test('元のlightMosaicは変更されない(新しいオブジェクトを返す)', () {
    const int width = 2;
    const int height = 2;
    final LinearRawMosaic master = _makeMosaic(
      width,
      height,
      CfaPattern.rggb,
      (int x, int y) => 5,
    );
    final LinearRawMosaic light = _makeMosaic(
      width,
      height,
      CfaPattern.rggb,
      (int x, int y) => 20,
    );
    final Float32List originalSamples = Float32List.fromList(light.samples);
    subtractDarkFrame(light, master);
    expect(light.samples, orderedEquals(originalSamples));
  });

  test('空のダークフレーム配列はInvalidDarkFrameInputを投げる', () {
    expect(
      () => computeMasterDark(const <LinearRawMosaic>[]),
      throwsA(isA<InvalidDarkFrameInput>()),
    );
  });

  test('寸法が異なるダークフレーム同士はInvalidDarkFrameInputを投げる', () {
    final LinearRawMosaic a = _makeMosaic(
      3,
      3,
      CfaPattern.rggb,
      (int x, int y) => 1,
    );
    final LinearRawMosaic b = _makeMosaic(
      4,
      4,
      CfaPattern.rggb,
      (int x, int y) => 1,
    );
    expect(
      () => computeMasterDark(<LinearRawMosaic>[a, b]),
      throwsA(isA<InvalidDarkFrameInput>()),
    );
  });

  test(
    'CFAパターンが異なるダークフレーム同士はInvalidDarkFrameInputを'
    '投げる',
    () {
      final LinearRawMosaic a = _makeMosaic(
        3,
        3,
        CfaPattern.rggb,
        (int x, int y) => 1,
      );
      final LinearRawMosaic b = _makeMosaic(
        3,
        3,
        CfaPattern.bggr,
        (int x, int y) => 1,
      );
      expect(
        () => computeMasterDark(<LinearRawMosaic>[a, b]),
        throwsA(isA<InvalidDarkFrameInput>()),
      );
    },
  );

  test(
    'light/masterの寸法・CFAパターン不一致はInvalidDarkFrameInputを'
    '投げる',
    () {
      final LinearRawMosaic light = _makeMosaic(
        3,
        3,
        CfaPattern.rggb,
        (int x, int y) => 10,
      );
      final LinearRawMosaic wrongSize = _makeMosaic(
        4,
        4,
        CfaPattern.rggb,
        (int x, int y) => 5,
      );
      expect(
        () => subtractDarkFrame(light, wrongSize),
        throwsA(isA<InvalidDarkFrameInput>()),
      );
      final LinearRawMosaic wrongPattern = _makeMosaic(
        3,
        3,
        CfaPattern.bggr,
        (int x, int y) => 5,
      );
      expect(
        () => subtractDarkFrame(light, wrongPattern),
        throwsA(isA<InvalidDarkFrameInput>()),
      );
    },
  );
  test('マスターダーク作成はNaN/Inf入力を中央値処理前に拒否する', () {
    final LinearRawMosaic valid = _makeMosaic(
      2,
      1,
      CfaPattern.rggb,
      (int x, int y) => x + 1,
    );
    final LinearRawMosaic nanFrame = _makeMosaic(
      2,
      1,
      CfaPattern.rggb,
      (int x, int y) => x == 0 ? double.nan : 2,
    );
    final LinearRawMosaic infFrame = _makeMosaic(
      2,
      1,
      CfaPattern.rggb,
      (int x, int y) => x == 0 ? double.infinity : 2,
    );
    expect(
      () => computeMasterDark(<LinearRawMosaic>[valid, nanFrame]),
      throwsA(isA<InvalidDarkFrameInput>()),
    );
    expect(
      () => computeMasterDark(<LinearRawMosaic>[valid, infFrame]),
      throwsA(isA<InvalidDarkFrameInput>()),
    );
  });

  test('センサー飽和したdark観測はpixel中央値から除外される', () {
    LinearRawMosaic build(double first, bool saturated) => LinearRawMosaic(
          width: 2,
          height: 2,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List.fromList(<double>[first, 5, 5, 5]),
          saturationMask: RawSaturationMask.fromPredicate(
            4,
            (int index) => saturated && index == 0,
          ),
        );

    final LinearRawMosaic master = computeMasterDark(<LinearRawMosaic>[
      build(10000, true),
      build(5, false),
      build(5, false),
    ]);
    expect(master.samples[0], 5);
    expect(master.saturationMask, isNull);
  });

  test('全darkが同一pixelで飽和した場合はinvalidとしてlightへ伝播する', () {
    LinearRawMosaic dark(double other) => LinearRawMosaic(
          width: 2,
          height: 2,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List.fromList(<double>[10000, other, other, other]),
          saturationMask: RawSaturationMask.fromPredicate(
            4,
            (int index) => index == 0,
          ),
        );

    final LinearRawMosaic master = computeMasterDark(<LinearRawMosaic>[
      dark(5),
      dark(6),
    ]);
    expect(master.saturationMask?.isSaturatedIndex(0), isTrue);

    final LinearRawMosaic light = _makeMosaic(
      2,
      2,
      CfaPattern.rggb,
      (int x, int y) => 20,
    );
    final LinearRawMosaic result = subtractDarkFrame(light, master);
    expect(result.samples[0], 20);
    expect(result.saturationMask?.isSaturatedIndex(0), isTrue);
    expect(result.samples[1], closeTo(14.5, 1e-6));
  });
}
