import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/invert_similarity_transform_with_local_correction.dart';
import 'package:mobile_stack/core/registration/local_residual_correction.dart';
import 'package:mobile_stack/core/registration/similarity_transform_math.dart';

/// Dart port of `tool/raw_samples/test/invert_similarity_transform_
/// with_local_correction_reference.test.mjs`.

final class _Estimate implements SimilarityTransformEstimate {
  const _Estimate({
    required this.rotationDegrees,
    required this.sourceOffsetX,
    required this.sourceOffsetY,
    required this.centerX,
    required this.centerY,
  });

  @override
  final double rotationDegrees;
  @override
  final double sourceOffsetX;
  @override
  final double sourceOffsetY;
  @override
  final double centerX;
  @override
  final double centerY;
}

/// 空(マッチ数不足)のフィールドを構築することで、常に補正0を返す
/// フィールドを得る(fitLocalResidualCorrectionField自身のfitted=false
/// フォールバックを再利用する、独立した「ゼロ補正フィールド」の
/// テストダブルを新たに作らずに済む)。
LocalResidualCorrectionField _zeroCorrectionField() {
  return fitLocalResidualCorrectionField(const <LocalResidualMatch>[]);
}

/// 位置に依存しない定数残差(dx, dy)を持つマッチ群から、実際に
/// フィットされた(定数項のみが非ゼロな)局所補正場を構築する。
LocalResidualCorrectionField _constantCorrectionField(double dx, double dy) {
  final List<LocalResidualMatch> matches = <LocalResidualMatch>[
    for (int x = -3; x <= 3; x++)
      for (int y = -3; y <= 3; y++)
        LocalResidualMatch(
          referenceX: x.toDouble(),
          referenceY: y.toDouble(),
          residualX: dx,
          residualY: dy,
        ),
  ];
  return fitLocalResidualCorrectionField(
    matches,
    minimumMatchesPerCoefficient: 4,
  );
}

void main() {
  test(
    '局所補正が常に0の場合、反復ベースの逆変換は既存の解析的な'
    'invertSimilarityTransformと厳密に一致する(後方互換性の検証)',
    () {
      const _Estimate estimate = _Estimate(
        rotationDegrees: 15,
        sourceOffsetX: 3,
        sourceOffsetY: -2,
        centerX: 50,
        centerY: 40,
      );
      final ({double x, double y}) Function(double, double) globalOnlyInverse =
          invertSimilarityTransform(estimate);
      final ({double x, double y}) Function(double, double) combinedInverse =
          invertSimilarityTransformWithLocalCorrection(
        estimate,
        _zeroCorrectionField(),
        globalOnlyInverse,
      );

      for (final (double, double) point in <(double, double)>[
        (10, 20),
        (100, 5),
        (-30, 60),
      ]) {
        final expected = globalOnlyInverse(point.$1, point.$2);
        final actual = combinedInverse(point.$1, point.$2);
        expect((actual.x - expected.x).abs(), lessThan(1e-9));
        expect((actual.y - expected.y).abs(), lessThan(1e-9));
      }
    },
  );

  test(
    '大域変換が恒等・局所補正が定数の場合、逆変換は単純な減算になる'
    '(手計算検証)',
    () {
      // 大域変換=恒等、局所補正=定数(0.5, -0.3)。
      // 真の順方向: source = reference + (0.5, -0.3)。
      // 真の逆変換: reference = source - (0.5, -0.3)。
      // source=(10,20) -> reference=(9.5, 20.3)であるはず。
      const _Estimate estimate = _Estimate(
        rotationDegrees: 0,
        sourceOffsetX: 0,
        sourceOffsetY: 0,
        centerX: 0,
        centerY: 0,
      );
      final LocalResidualCorrectionField field = _constantCorrectionField(
        0.5,
        -0.3,
      );
      expect(field.fitted, isTrue);
      final ({double x, double y}) Function(double, double) globalOnlyInverse =
          invertSimilarityTransform(estimate);
      final ({double x, double y}) Function(double, double) combinedInverse =
          invertSimilarityTransformWithLocalCorrection(
        estimate,
        field,
        globalOnlyInverse,
      );

      final result = combinedInverse(10, 20);
      expect((result.x - 9.5).abs(), lessThan(1e-6));
      expect((result.y - 20.3).abs(), lessThan(1e-6));
    },
  );

  test(
    '逆変換した結果を順方向(大域+局所)へ適用し直すと、元のsource位置に'
    '戻る(round-trip検証、位置依存の局所補正を含む)',
    () {
      const _Estimate estimate = _Estimate(
        rotationDegrees: 10,
        sourceOffsetX: 5,
        sourceOffsetY: -3,
        centerX: 20,
        centerY: 15,
      );
      final List<LocalResidualMatch> matches = <LocalResidualMatch>[
        for (int x = -3; x <= 3; x++)
          for (int y = -3; y <= 3; y++)
            LocalResidualMatch(
              referenceX: x.toDouble(),
              referenceY: y.toDouble(),
              residualX: 0.01 * x,
              residualY: 0.02 * y,
            ),
      ];
      final LocalResidualCorrectionField field =
          fitLocalResidualCorrectionField(
        matches,
        minimumMatchesPerCoefficient: 4,
      );
      expect(field.fitted, isTrue);

      final ({double x, double y}) Function(double, double) globalOnlyInverse =
          invertSimilarityTransform(estimate);
      final ({double x, double y}) Function(double, double) combinedInverse =
          invertSimilarityTransformWithLocalCorrection(
        estimate,
        field,
        globalOnlyInverse,
        iterationCount: 6,
      );

      for (final (double, double) point in <(double, double)>[
        (0, 0),
        (1, -1),
        (2, 2),
      ]) {
        final reference = combinedInverse(point.$1, point.$2);
        final globalPrediction = applySimilarityForward(
          estimate,
          reference.x,
          reference.y,
        );
        final correction = field.evaluate(reference.x, reference.y);
        final double roundTripSourceX = globalPrediction.x + correction.dx;
        final double roundTripSourceY = globalPrediction.y + correction.dy;
        expect((roundTripSourceX - point.$1).abs(), lessThan(1e-4));
        expect((roundTripSourceY - point.$2).abs(), lessThan(1e-4));
      }
    },
  );

  test(
    'iterationCountが正の整数でない場合は'
    'InvalidLocalCorrectionInversionInputを投げる',
    () {
      const _Estimate estimate = _Estimate(
        rotationDegrees: 0,
        sourceOffsetX: 0,
        sourceOffsetY: 0,
        centerX: 0,
        centerY: 0,
      );
      expect(
        () => invertSimilarityTransformWithLocalCorrection(
          estimate,
          _zeroCorrectionField(),
          invertSimilarityTransform(estimate),
          iterationCount: 0,
        ),
        throwsA(isA<InvalidLocalCorrectionInversionInput>()),
      );
    },
  );
  test('局所補正逆変換は非有限source座標を拒否する', () {
    const _Estimate estimate = _Estimate(
      rotationDegrees: 0,
      sourceOffsetX: 0,
      sourceOffsetY: 0,
      centerX: 0,
      centerY: 0,
    );
    final inverse = invertSimilarityTransformWithLocalCorrection(
      estimate,
      _zeroCorrectionField(),
      (double x, double y) => (x: x, y: y),
    );
    expect(
      () => inverse(double.nan, 0),
      throwsA(isA<InvalidLocalCorrectionInversionInput>()),
    );
  });
}
