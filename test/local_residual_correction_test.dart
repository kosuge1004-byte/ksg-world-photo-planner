import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/local_residual_correction.dart';

/// Dart port of `tool/raw_samples/test/local_residual_correction_
/// reference.test.mjs`.

double _trueResidualX(double x, double y) {
  return 0.5 + 0.1 * x + 0.05 * y + 0.02 * x * x + 0.01 * x * y + 0.015 * y * y;
}

double _trueResidualY(double x, double y) {
  return -0.3 +
      0.08 * x -
      0.06 * y +
      0.01 * x * x -
      0.02 * x * y +
      0.025 * y * y;
}

List<LocalResidualMatch> _buildGridMatches() {
  final List<LocalResidualMatch> matches = <LocalResidualMatch>[];
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      matches.add(
        LocalResidualMatch(
          referenceX: x.toDouble(),
          referenceY: y.toDouble(),
          residualX: _trueResidualX(x.toDouble(), y.toDouble()),
          residualY: _trueResidualY(x.toDouble(), y.toDouble()),
        ),
      );
    }
  }
  return matches; // 25点(5x5グリッド)
}

void main() {
  test(
    '既知の2次多項式歪み場から生成したデータに対し、フィットが元の'
    '関数値を正確に復元する(訓練データ点での検証)',
    () {
      final List<LocalResidualMatch> matches = _buildGridMatches();
      final LocalResidualCorrectionField field =
          fitLocalResidualCorrectionField(
        matches,
        minimumMatchesPerCoefficient: 4,
      );
      expect(field.fitted, isTrue);
      for (final (double x, double y) in <(double, double)>[
        (-2, -2),
        (0, 0),
        (1, -1),
        (2, 2),
      ]) {
        final LocalResidualCorrection correction = field.evaluate(x, y);
        final double expectedDx = _trueResidualX(x, y);
        final double expectedDy = _trueResidualY(x, y);
        expect(
          (correction.dx - expectedDx).abs(),
          lessThan(1e-6),
          reason: 'x=$x,y=$y',
        );
        expect(
          (correction.dy - expectedDy).abs(),
          lessThan(1e-6),
          reason: 'x=$x,y=$y',
        );
      }
    },
  );

  test(
    '一様な(位置に依存しない)残差データに対しては、定数項だけが'
    '復元される',
    () {
      final List<LocalResidualMatch> matches = <LocalResidualMatch>[];
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          matches.add(
            LocalResidualMatch(
              referenceX: x.toDouble(),
              referenceY: y.toDouble(),
              residualX: 1.5,
              residualY: -0.8,
            ),
          );
        }
      }
      final LocalResidualCorrectionField field =
          fitLocalResidualCorrectionField(
        matches,
        minimumMatchesPerCoefficient: 4,
      );
      expect(field.fitted, isTrue);
      final LocalResidualCorrection correction = field.evaluate(100, -50);
      expect((correction.dx - 1.5).abs(), lessThan(1e-6));
      expect((correction.dy - (-0.8)).abs(), lessThan(1e-6));
    },
  );

  test(
    'マッチ数が不足している場合、フィットせず常に0を返す'
    '(過剰適合の防止)',
    () {
      final List<LocalResidualMatch> matches = _buildGridMatches().sublist(
        0,
        10,
      );
      final LocalResidualCorrectionField field =
          fitLocalResidualCorrectionField(
        matches,
        minimumMatchesPerCoefficient: 4,
      );
      expect(field.fitted, isFalse);
      final LocalResidualCorrection correction = field.evaluate(0, 0);
      expect(correction.dx, 0);
      expect(correction.dy, 0);
    },
  );

  test(
    'maximumCorrectionMagnitudeを超える補正はクランプされる'
    '(過剰なワープの禁止)',
    () {
      final List<LocalResidualMatch> matches = <LocalResidualMatch>[];
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          matches.add(
            LocalResidualMatch(
              referenceX: x.toDouble(),
              referenceY: y.toDouble(),
              residualX: 100,
              residualY: 0,
            ),
          );
        }
      }
      final LocalResidualCorrectionField field =
          fitLocalResidualCorrectionField(
        matches,
        minimumMatchesPerCoefficient: 4,
        maximumCorrectionMagnitude: 3,
      );
      final LocalResidualCorrection correction = field.evaluate(0, 0);
      final double magnitude = math.sqrt(
        correction.dx * correction.dx + correction.dy * correction.dy,
      );
      expect((magnitude - 3).abs(), lessThan(1e-9));
    },
  );

  test(
    '全ての点が同一直線上(縮退)にある場合、singularなためfitted=false'
    'になる',
    () {
      final List<LocalResidualMatch> matches = <LocalResidualMatch>[];
      for (int x = -3; x <= 3; x++) {
        for (int i = 0; i < 5; i++) {
          matches.add(
            LocalResidualMatch(
              referenceX: x.toDouble(),
              referenceY: 0,
              residualX: x.toDouble(),
              residualY: 0,
            ),
          );
        }
      }
      final LocalResidualCorrectionField field =
          fitLocalResidualCorrectionField(
        matches,
        minimumMatchesPerCoefficient: 4,
      );
      expect(field.fitted, isFalse);
    },
  );

  test('不正なパラメータを拒否する', () {
    expect(
      () => fitLocalResidualCorrectionField(
        const <LocalResidualMatch>[],
        minimumMatchesPerCoefficient: 0,
      ),
      throwsA(isA<InvalidLocalResidualFitInput>()),
    );
    expect(
      () => fitLocalResidualCorrectionField(
        const <LocalResidualMatch>[],
        maximumCorrectionMagnitude: -1,
      ),
      throwsA(isA<InvalidLocalResidualFitInput>()),
    );
  });

  test(
    '実際の画像座標系スケール(0-4000px)・不規則な星の分布でも、'
    '座標正規化(Work124)により数値的に安定してフィットできる',
    () {
      double trueResidualX(double x, double y) {
        return 0.0015 * (x - 2000) -
            0.0008 * (y - 1500) +
            0.0000004 * (x - 2000) * (x - 2000) +
            0.0000002 * (x - 2000) * (y - 1500);
      }

      double trueResidualY(double x, double y) {
        return -0.001 * (x - 2000) +
            0.0012 * (y - 1500) +
            0.0000003 * (y - 1500) * (y - 1500);
      }

      int seed = 777;
      double next() {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      }

      final List<LocalResidualMatch> matches = <LocalResidualMatch>[
        for (int i = 0; i < 30; i++)
          () {
            final double x = next() * 4000;
            final double y = next() * 3000;
            return LocalResidualMatch(
              referenceX: x,
              referenceY: y,
              residualX: trueResidualX(x, y),
              residualY: trueResidualY(x, y),
            );
          }(),
      ];
      final LocalResidualCorrectionField field =
          fitLocalResidualCorrectionField(
        matches,
        minimumMatchesPerCoefficient: 4,
      );
      expect(field.fitted, isTrue);

      // クランプ(maximumCorrectionMagnitude、既定3)の影響を受けない、
      // 補正の大きさが3未満に収まる検証点だけで精度を確認する。
      for (final (double, double) point in <(double, double)>[
        (500, 500),
        (3500, 2500),
        (2000, 1500),
      ]) {
        final LocalResidualCorrection result = field.evaluate(
          point.$1,
          point.$2,
        );
        final double expectedX = trueResidualX(point.$1, point.$2);
        final double expectedY = trueResidualY(point.$1, point.$2);
        expect(
          (result.dx - expectedX).abs(),
          lessThan(1e-9),
          reason: 'x mismatch at $point',
        );
        expect(
          (result.dy - expectedY).abs(),
          lessThan(1e-9),
          reason: 'y mismatch at $point',
        );
      }
    },
  );
  test('非有限な局所残差matchをフィットへ流さない', () {
    final List<LocalResidualMatch> matches = _buildGridMatches();
    matches[0] = const LocalResidualMatch(
      referenceX: 0,
      referenceY: 0,
      residualX: double.nan,
      residualY: 0,
    );
    expect(
      () => fitLocalResidualCorrectionField(matches),
      throwsA(isA<InvalidLocalResidualFitInput>()),
    );
  });

  test('フィット済み局所補正は非有限評価座標を拒否する', () {
    final LocalResidualCorrectionField field = fitLocalResidualCorrectionField(
      _buildGridMatches(),
      minimumMatchesPerCoefficient: 1,
      maximumCorrectionMagnitude: 100,
    );
    expect(
      () => field.evaluate(double.nan, 0),
      throwsA(isA<InvalidLocalResidualFitInput>()),
    );
  });

  test(
    '1個の大きな誤マッチをMAD除外して局所残差場を再フィットする',
    () {
      final List<LocalResidualMatch> matches = _buildGridMatches()
        ..add(
          const LocalResidualMatch(
            referenceX: 0.35,
            referenceY: -0.45,
            residualX: 40,
            residualY: -35,
          ),
        );
      final LocalResidualCorrectionField field =
          fitLocalResidualCorrectionField(
        matches,
        minimumMatchesPerCoefficient: 4,
        maximumCorrectionMagnitude: 100,
      );
      expect(field.fitted, isTrue);
      for (final (double x, double y) in <(double, double)>[
        (-2, -2),
        (0, 0),
        (2, 2),
        (1, -1),
      ]) {
        final LocalResidualCorrection correction = field.evaluate(x, y);
        expect(
          (correction.dx - _trueResidualX(x, y)).abs(),
          lessThan(1e-6),
          reason: 'dx mismatch at x=$x,y=$y',
        );
        expect(
          (correction.dy - _trueResidualY(x, y)).abs(),
          lessThan(1e-6),
          reason: 'dy mismatch at x=$x,y=$y',
        );
      }
    },
  );

// Work254: the frame-quality weight must be based on the transform that is
// actually sampled after local correction, not on the pre-local global RMS.
  test('corrected RMS reflects the fitted local residual field', () {
    final List<LocalResidualMatch> matches = _buildGridMatches();
    final double globalRms = localResidualCorrectedRms(matches, null);
    final LocalResidualCorrectionField field = fitLocalResidualCorrectionField(
      matches,
      minimumMatchesPerCoefficient: 2,
      maximumCorrectionMagnitude: 3,
    );
    final double correctedRms = localResidualCorrectedRms(matches, field);

    expect(field.fitted, isTrue);
    expect(globalRms, greaterThan(0));
    expect(correctedRms, lessThan(globalRms));
    expect(correctedRms, lessThan(1e-9));
  });
}
