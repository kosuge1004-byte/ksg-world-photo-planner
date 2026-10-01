import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/stacking/comprehensive_frame_quality_weight.dart';

/// Dart port of `tool/raw_samples/test/comprehensive_frame_quality_
/// weight_reference.test.mjs`.

void main() {
  test(
    'starShapeQualityWeight: 中央値roundnessから逆二乗減衰で計算される'
    '(手計算検証)',
    () {
      final double weight = starShapeQualityWeight(<double>[0.1, 0.2, 0.3]);
      expect((weight - 0.6923076923076923).abs(), lessThan(1e-9));
    },
  );

  test('starShapeQualityWeight: 完全な丸(roundness=0)の星ばかりなら重み1', () {
    final double weight = starShapeQualityWeight(<double>[0, 0, 0]);
    expect(weight, 1);
  });

  test('starShapeQualityWeight: 検出星が無い場合は重み1(ペナルティなし)', () {
    final double weight = starShapeQualityWeight(const <double>[]);
    expect(weight, 1);
  });

  test(
    'starShapeQualityWeight: 少数の歪んだ検出に平均ではなく中央値が'
    '頑健であることの検証',
    () {
      final List<double> roundness = <double>[
        ...List<double>.filled(9, 0.05),
        0.9,
      ];
      final double weight = starShapeQualityWeight(roundness);
      expect(
        weight,
        greaterThan(0.9),
        reason: 'expected weight close to 1 (median-robust), got $weight',
      );
    },
  );

  test(
    'starCountQualityWeight: 参照より少ない検出数は逆二乗減衰で減点される'
    '(手計算検証)',
    () {
      final double weight = starCountQualityWeight(10, 20);
      expect((weight - 0.5).abs(), lessThan(1e-9));
    },
  );

  test('starCountQualityWeight: 参照と同数以上なら重み1(減点なし)', () {
    expect(starCountQualityWeight(20, 20), 1);
    expect(starCountQualityWeight(25, 20), 1);
  });

  test('starCountQualityWeight: 参照星数が0なら重み1', () {
    expect(starCountQualityWeight(5, 0), 1);
  });

  test(
    'comprehensiveFrameQualityWeight: 3つの要因が乗算で結合される'
    '(手計算検証)',
    () {
      final double combined = comprehensiveFrameQualityWeight(
        registrationWeight: 0.8,
        roundnessValues: <double>[0.1, 0.2, 0.3],
        detectedStarCount: 10,
        referenceStarCount: 20,
      );
      expect(
        (combined - 0.8 * 0.6923076923076923 * 0.5).abs(),
        lessThan(1e-9),
      );
    },
  );

  test(
    'comprehensiveFrameQualityWeight: 検出星情報が無い場合は'
    'registrationWeightのみに帰着する(既存挙動との後方互換性)',
    () {
      final double combined = comprehensiveFrameQualityWeight(
        registrationWeight: 0.73,
        roundnessValues: const <double>[],
        detectedStarCount: 20,
        referenceStarCount: 20,
      );
      expect((combined - 0.73).abs(), lessThan(1e-9));
    },
  );

  test(
    'comprehensiveFrameQualityWeight: minimumWeightで下限にクランプされる',
    () {
      final double combined = comprehensiveFrameQualityWeight(
        registrationWeight: 0.1,
        roundnessValues: <double>[0.9, 0.9, 0.9],
        detectedStarCount: 1,
        referenceStarCount: 100,
        minimumWeight: 0.05,
      );
      expect(combined, 0.05);
    },
  );

  test('不正なパラメータを拒否する', () {
    expect(
      () => starShapeQualityWeight(<double>[1.5]),
      throwsA(isA<InvalidFrameQualityWeightInput>()),
    );
    expect(
      () => starShapeQualityWeight(<double>[0.1], roundnessHalfWeight: 0),
      throwsA(isA<InvalidFrameQualityWeightInput>()),
    );
    expect(
      () => starCountQualityWeight(-1, 10),
      throwsA(isA<InvalidFrameQualityWeightInput>()),
    );
    expect(
      () => starCountQualityWeight(5, -1),
      throwsA(isA<InvalidFrameQualityWeightInput>()),
    );
    expect(
      () => comprehensiveFrameQualityWeight(
        registrationWeight: 1.5,
        roundnessValues: const <double>[],
        detectedStarCount: 1,
        referenceStarCount: 1,
      ),
      throwsA(isA<InvalidFrameQualityWeightInput>()),
    );
  });
  test('無限大の画質weightスケールを拒否する', () {
    expect(
      () => starShapeQualityWeight(
        <double>[0.1, 0.2],
        roundnessHalfWeight: double.infinity,
      ),
      throwsA(isA<InvalidFrameQualityWeightInput>()),
    );
    expect(
      () => starCountQualityWeight(
        5,
        10,
        countShortfallHalfWeightFraction: double.infinity,
      ),
      throwsA(isA<InvalidFrameQualityWeightInput>()),
    );
  });
}
