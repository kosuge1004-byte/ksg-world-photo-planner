import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/cfa_drizzle.dart';
import 'package:mobile_stack/core/drizzle/drizzle_accumulator.dart';
import 'package:mobile_stack/core/drizzle/drizzle_gap_fill.dart';

/// Dart port of `tool/raw_samples/test/drizzle_gap_fill_reference.
/// test.mjs` (excluding the "kernelRadius must be an integer" rejection
/// case: unreachable in Dart, since `kernelRadius` is itself typed
/// `int` — see `drizzle_gap_fill.dart`'s own doc comment).

DrizzleResult _makeChannel(
  int width,
  int height,
  double Function(int x, int y) valueFn,
  double Function(int x, int y) coverageFn,
) {
  final Float64List value = Float64List(width * height);
  final Float64List coverage = Float64List(width * height);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      final int index = y * width + x;
      value[index] = valueFn(x, y);
      coverage[index] = coverageFn(x, y);
    }
  }
  return DrizzleResult(
    width: width,
    height: height,
    value: value,
    coverage: coverage,
  );
}

void main() {
  test('十分なcoverageを持つ位置はvalue/coverageともに一切変更されない', () {
    final DrizzleResult channel = _makeChannel(
      5,
      5,
      (int x, int y) => (x * 10 + y).toDouble(),
      (int x, int y) => 3,
    );
    final DrizzleResult result = fillChannelGaps(channel, 5, 5);
    expect(result.value, orderedEquals(channel.value));
    expect(result.coverage, orderedEquals(channel.coverage));
  });

  test('coverage不足の位置は近傍のcoverage加重平均で埋められる', () {
    final DrizzleResult channel = _makeChannel(
      3,
      3,
      (int x, int y) => (x == 1 && y == 1) ? 999 : ((x + y) * 10).toDouble(),
      (int x, int y) => (x == 1 && y == 1) ? 0 : 1,
    );
    final DrizzleResult result = fillChannelGaps(
      channel,
      3,
      3,
      kernelRadius: 1,
    );
    final List<double> expectedNeighbors = <double>[];
    for (int ny = 0; ny <= 2; ny++) {
      for (int nx = 0; nx <= 2; nx++) {
        if (nx == 1 && ny == 1) continue;
        expectedNeighbors.add(((nx + ny) * 10).toDouble());
      }
    }
    final double expectedAverage =
        expectedNeighbors.reduce((double a, double b) => a + b) /
            expectedNeighbors.length;
    expect(
      (result.value[1 * 3 + 1] - expectedAverage).abs(),
      lessThan(1e-9),
    );
    expect(result.coverage[1 * 3 + 1], 0);
  });

  test(
    'coverageが高い近傍ほど埋め値への寄与が大きい(加重平均であることの'
    '確認)',
    () {
      const int width = 3;
      const int height = 1;
      final Float64List value = Float64List.fromList(<double>[0, 0, 100]);
      final Float64List coverage = Float64List.fromList(<double>[1, 0, 9]);
      final DrizzleResult channel = DrizzleResult(
        width: width,
        height: height,
        value: value,
        coverage: coverage,
      );
      final DrizzleResult result = fillChannelGaps(
        channel,
        width,
        height,
        kernelRadius: 1,
      );
      expect((result.value[1] - 90).abs(), lessThan(1e-9));
      expect(result.coverage[1], 0);
    },
  );

  test(
    'kernelRadius内に十分なcoverageの近傍が無い場合はvalue/coverageとも'
    '0のまま',
    () {
      final DrizzleResult channel = _makeChannel(
        5,
        5,
        (int x, int y) => 999,
        (int x, int y) => 0,
      );
      final DrizzleResult result = fillChannelGaps(
        channel,
        5,
        5,
        kernelRadius: 1,
      );
      expect(result.value.every((double v) => v == 0), isTrue);
      expect(result.coverage.every((double v) => v == 0), isTrue);
    },
  );

  test(
    '端・角の位置はkernelRadiusを画像範囲内にクリップして処理する'
    '(クラッシュしない)',
    () {
      final DrizzleResult channel = _makeChannel(
        4,
        4,
        (int x, int y) => (x + y).toDouble(),
        (int x, int y) => (x == 0 && y == 0) ? 0 : 1,
      );
      final DrizzleResult result = fillChannelGaps(
        channel,
        4,
        4,
        kernelRadius: 2,
      );
      expect(result.value[0].isFinite, isTrue);
      expect(result.coverage[0], 0);
    },
  );

  test('minimumCoverageのしきい値で「十分なcoverage」の境界を制御できる', () {
    final DrizzleResult channel = _makeChannel(
      3,
      3,
      (int x, int y) => 50,
      (int x, int y) => (x == 1 && y == 1) ? 0.5 : 1,
    );
    final DrizzleResult strict = fillChannelGaps(
      channel,
      3,
      3,
      minimumCoverage: 1,
    );
    final DrizzleResult lenient = fillChannelGaps(
      channel,
      3,
      3,
      minimumCoverage: 0.1,
    );
    expect(strict.coverage[1 * 3 + 1], 0);
    expect(lenient.coverage[1 * 3 + 1], 0.5);
  });

  test('補間値は作ってもsource coverageを新規生成しない', () {
    final DrizzleResult channel = _makeChannel(
      5,
      1,
      (int x, int y) => x == 0 ? 100 : 0,
      (int x, int y) => x == 0 ? 1 : 0,
    );
    final DrizzleResult result = fillChannelGaps(
      channel,
      5,
      1,
      kernelRadius: 1,
    );
    expect(result.value[1], 100);
    expect(result.coverage[1], 0);
    // Gap fill is one pass over original source coverage. The synthesized
    // x=1 value must not manufacture coverage that then propagates to x=2.
    expect(result.value[2], 0);
    expect(result.coverage[2], 0);
  });

  test('fillDrizzleResultGapsは各チャンネルを独立に(混ぜずに)埋める', () {
    final DrizzleResult redChannel = _makeChannel(
      3,
      3,
      (int x, int y) => (x == 1 && y == 1) ? 0 : 5,
      (int x, int y) => (x == 1 && y == 1) ? 0 : 1,
    );
    final DrizzleResult greenChannel = _makeChannel(
      3,
      3,
      (int x, int y) => 999,
      (int x, int y) => 1,
    );
    final DrizzleResult blueChannel = _makeChannel(
      3,
      3,
      (int x, int y) => 999,
      (int x, int y) => 1,
    );
    final CfaDrizzleResult result = fillDrizzleResultGaps(
      CfaDrizzleResult(
        width: 3,
        height: 3,
        channels: <DrizzleResult>[redChannel, greenChannel, blueChannel],
      ),
    );
    expect((result.channels[0].value[4] - 5).abs(), lessThan(1e-9));
  });

  test('不正な入力を拒否する', () {
    expect(
      () => fillChannelGaps(
        DrizzleResult(
          width: 3,
          height: 3,
          value: Float64List(4),
          coverage: Float64List(4),
        ),
        3,
        3,
      ),
      throwsA(isA<InvalidGapFillInput>()),
    );
    expect(
      () => fillChannelGaps(
        DrizzleResult(
          width: 3,
          height: 3,
          value: Float64List(9),
          coverage: Float64List(9),
        ),
        3,
        3,
        kernelRadius: 0,
      ),
      throwsA(isA<InvalidGapFillInput>()),
    );
    expect(
      () => fillChannelGaps(
        DrizzleResult(
          width: 3,
          height: 3,
          value: Float64List(9),
          coverage: Float64List(9),
        ),
        3,
        3,
        minimumCoverage: -1,
      ),
      throwsA(isA<InvalidGapFillInput>()),
    );
  });
}
