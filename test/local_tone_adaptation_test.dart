import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/local_tone_adaptation.dart';

/// Dart port of `tool/raw_samples/test/local_tone_adaptation_
/// reference.test.mjs` (excluding the "radius must be an integer"
/// rejection case: unreachable in Dart, since `radius` is itself typed
/// `int` — see `local_tone_adaptation.dart`'s own doc comment).

void main() {
  test('computeLuminanceはBT.709の重みで正確に計算される', () {
    final Float32List rgb = Float32List.fromList(<double>[
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
    ]);
    final Float64List luminance = computeLuminance(rgb, 3, 1);
    expect((luminance[0] - 0.2126).abs(), lessThan(1e-9));
    expect((luminance[1] - 0.7152).abs(), lessThan(1e-9));
    expect((luminance[2] - 0.0722).abs(), lessThan(1e-9));
  });

  test('computeLuminanceは負値・非有限値を0として扱う', () {
    final Float32List rgb = Float32List.fromList(<double>[
      -1,
      double.nan,
      double.infinity,
    ]);
    final Float64List luminance = computeLuminance(rgb, 1, 1);
    expect(luminance[0], 0);
  });

  test(
    'computeLuminance preserves signed residual cancellation before the final luminance clamp',
    () {
      final Float32List rgb = Float32List.fromList(<double>[-0.1, 0.1, 0]);
      final Float64List luminance = computeLuminance(rgb, 1, 1);
      final double expected = -0.1 * 0.2126 + 0.1 * 0.7152;
      expect((luminance[0] - expected).abs(), lessThan(1e-8));
    },
  );

  test('boxBlurのradius=0は入力をそのまま(コピーとして)返す', () {
    final Float64List plane = Float64List.fromList(<double>[1, 2, 3, 4]);
    final Float64List blurred = boxBlur(plane, 2, 2, 0);
    expect(blurred, orderedEquals(plane));
    expect(identical(blurred, plane), isFalse);
  });

  test('一様な平面をぼかしても値は変わらない', () {
    final Float64List plane = Float64List(9)..fillRange(0, 9, 5);
    final Float64List blurred = boxBlur(plane, 3, 3, 1);
    for (final double value in blurred) {
      expect((value - 5).abs(), lessThan(1e-9));
    }
  });

  test(
    '端の画素は範囲外を最近傍でクランプしてぼかされる'
    '(具体的な数値で検証)',
    () {
      final Float64List plane = Float64List.fromList(<double>[10, 20, 30]);
      final Float64List blurred = boxBlur(plane, 3, 1, 1);
      expect((blurred[0] - 40 / 3).abs(), lessThan(1e-9));
      expect((blurred[1] - 20).abs(), lessThan(1e-9));
      expect((blurred[2] - 80 / 3).abs(), lessThan(1e-9));
    },
  );

  test('boxBlurは不正なradius・寸法不一致を拒否する', () {
    final Float64List plane = Float64List(4);
    expect(
      () => boxBlur(plane, 2, 2, -1),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
    expect(
      () => boxBlur(Float64List(3), 2, 2, 1),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
  });

  test('strength=0では全画素の利得が厳密に1になる', () {
    final Float64List surround = Float64List.fromList(<double>[
      0.01,
      0.5,
      10,
      0.0001,
    ]);
    final Float64List gain = computeLocalGain(surround, strength: 0);
    for (final double value in gain) {
      expect(value, 1);
    }
  });

  test(
    '周辺輝度が基準パーセンタイルより暗い画素は利得>1(明るくなる)、'
    '明るい画素は利得<=1になる(この設計の核心的な価値の検証)',
    () {
      final Float64List surround = Float64List.fromList(<double>[
        0.1,
        1,
        1,
        1,
        10,
      ]);
      final Float64List gain = computeLocalGain(
        surround,
        strength: 1,
        minGain: 0.01,
        maxGain: 100,
      );
      expect(gain[0], greaterThan(1));
      expect(gain[4], lessThanOrEqualTo(1));
    },
  );

  test('minGain/maxGainで利得が実際にクランプされる', () {
    // 20要素: 大部分(17個)が1、極端に暗い2個(0.0001)、極端に明るい
    // 1個(1000)。85パーセンタイルは「1」の範囲内に安定して収まるため、
    // 基準値はほぼ1になり、両極端の値が明確にクランプされる状況を作る。
    final Float64List surround = Float64List.fromList(<double>[
      0.0001,
      0.0001,
      ...List<double>.filled(17, 1),
      1000,
    ]);
    expect(surround.length, 20);
    final Float64List gain = computeLocalGain(
      surround,
      strength: 1,
      minGain: 0.5,
      maxGain: 2,
    );
    expect(gain[0], 2);
    expect(gain[19], 0.5);
  });

  test('computeLocalGainは不正なパラメータを拒否する', () {
    final Float64List surround = Float64List.fromList(<double>[1, 1]);
    expect(
      () => computeLocalGain(surround, strength: -1),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
    expect(
      () => computeLocalGain(surround, epsilon: 0),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
    expect(
      () => computeLocalGain(surround, minGain: 2, maxGain: 1),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
    expect(
      () => computeLocalGain(surround, referencePercentile: -0.1),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
    expect(
      () => computeLocalGain(surround, referencePercentile: 1.1),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
    expect(
      () => computeLocalGain(Float64List(0)),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
    expect(
      () => computeLocalGain(
        Float64List.fromList(<double>[1, double.nan]),
      ),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
    expect(
      () => computeLocalGain(surround, strength: double.infinity),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
    expect(
      () => computeLocalGain(surround, referencePercentile: double.nan),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
  });

  test('applyLocalGainは各画素のR/G/Bへ同じ利得を一様に掛ける', () {
    final Float32List rgb = Float32List.fromList(<double>[1, 2, 3, 4, 5, 6]);
    final Float64List gain = Float64List.fromList(<double>[2, 0.5]);
    final Float32List result = applyLocalGain(rgb, gain);
    expect(result, orderedEquals(<double>[2, 4, 6, 2, 2.5, 3]));
  });

  test('元のrgbは変更されない(新しい配列を返す)', () {
    final Float32List rgb = Float32List.fromList(<double>[1, 2, 3]);
    final Float32List original = Float32List.fromList(rgb);
    applyLocalGain(rgb, Float64List.fromList(<double>[2]));
    expect(rgb, orderedEquals(original));
  });

  test('applyLocalGainはgainとrgbの画素数不一致を拒否する', () {
    expect(
      () => applyLocalGain(Float32List(6), Float64List(1)),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
  });

  test('applyLocalGainは非有限の利得を拒否する', () {
    expect(
      () => applyLocalGain(
        Float32List.fromList(<double>[1, 2, 3]),
        Float64List.fromList(<double>[double.infinity]),
      ),
      throwsA(isA<InvalidLocalToneAdaptationInput>()),
    );
  });

  test(
    'applyLocalToneAdaptation: strength=0では入力と数値的に同じ結果を'
    '返す(新しい配列だが値は不変、既存パイプラインへの無害な追加で'
    'あることの確認)',
    () {
      final Float32List rgb = Float32List.fromList(<double>[
        0.1,
        0.2,
        0.3,
        5,
        6,
        7,
      ]);
      final Float32List result = applyLocalToneAdaptation(
        rgb,
        2,
        1,
        strength: 0,
      );
      expect(result, orderedEquals(rgb));
      expect(identical(result, rgb), isFalse);
    },
  );

  test(
    'applyLocalToneAdaptation: 暗い背景領域と明るい星領域を持つ合成画像'
    'で、背景が明るくなり星がこれ以上増幅されないことを確認'
    '(Work55の既知の限界に対する解決の直接検証)',
    () {
      const int width = 8;
      const int height = 8;
      final Float32List rgb = Float32List(width * height * 3);
      for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
          final int index = y * width + x;
          final bool isStar = x >= 6 && y <= 1;
          final double value = isStar ? 5.0 : 0.02;
          rgb[index * 3] = value;
          rgb[index * 3 + 1] = value;
          rgb[index * 3 + 2] = value;
        }
      }
      final Float32List result = applyLocalToneAdaptation(
        rgb,
        width,
        height,
        blurRadius: 3,
        strength: 0.5,
        minGain: 0.1,
        maxGain: 10,
      );
      final int backgroundIndex = (7 * width + 0) * 3;
      expect(
        result[backgroundIndex],
        greaterThan(rgb[backgroundIndex]),
        reason: 'expected background to brighten',
      );
      final int starIndex = (0 * width + 7) * 3;
      expect(
        result[starIndex],
        lessThanOrEqualTo(rgb[starIndex] * 1.01),
        reason: 'expected star not to be amplified further',
      );
    },
  );

  test('computeLuminance accepts explicit linear-RGB luminance weights', () {
    final Float64List luminance = computeLuminance(
      Float32List.fromList(<double>[1, 0, 0, 0, 1, 0]),
      2,
      1,
      luminanceWeights: const <double>[0.25, 0.75, 0],
    );
    expect(luminance, orderedEquals(<double>[0.25, 0.75]));
  });
}
