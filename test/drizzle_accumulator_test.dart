import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/drizzle_accumulator.dart';

void main() {
  test('rejects non-positive dimensions', () {
    expect(
      () => DrizzleAccumulator(width: 0, height: 2),
      throwsA(isA<InvalidDrizzleInput>()),
    );
  });

  test('pixfrac one at integer centers reproduces input exactly', () {
    final DrizzleAccumulator accumulator = DrizzleAccumulator(
      width: 4,
      height: 4,
    );
    for (int y = 0; y < 4; y++) {
      for (int x = 0; x < 4; x++) {
        accumulator.addDrop(x.toDouble(), y.toDouble(), y * 4 + x + 1);
      }
    }
    final DrizzleResult result = accumulator.finalize();
    for (int index = 0; index < 16; index++) {
      expect(result.value[index], closeTo(index + 1, 1e-12));
      expect(result.coverage[index], closeTo(1, 1e-12));
    }
  });

  test('fractional drop splits by exact overlap area', () {
    final DrizzleAccumulator accumulator = DrizzleAccumulator(
      width: 3,
      height: 1,
    )..addDrop(0.75, 0, 8);
    final DrizzleResult result = accumulator.finalize();
    expect(result.value[0], closeTo(8, 1e-12));
    expect(result.value[1], closeTo(8, 1e-12));
    expect(result.coverage[0], closeTo(0.25, 1e-12));
    expect(result.coverage[1], closeTo(0.75, 1e-12));
    expect(result.coverage[2], 0);
  });

  test('quality weight scales value and coverage contributions', () {
    final DrizzleAccumulator accumulator = DrizzleAccumulator(
      width: 2,
      height: 1,
    )
      ..addDrop(0, 0, 10)
      ..addDrop(0, 0, 20, weight: 3);
    final DrizzleResult result = accumulator.finalize();
    expect(result.value[0], closeTo(17.5, 1e-12));
    expect(result.coverage[0], closeTo(4, 1e-12));
  });

  test('axis-aligned fractional drops conserve total flux', () {
    final DrizzleAccumulator accumulator = DrizzleAccumulator(
      width: 5,
      height: 5,
    );
    int seed = 42;
    double next() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }

    double expectedFlux = 0;
    for (int index = 0; index < 20; index++) {
      final double value = 1 + next() * 9;
      accumulator.addDrop(1 + next() * 2, 1 + next() * 2, value);
      expectedFlux += value;
    }
    final DrizzleResult result = accumulator.finalize();
    double actualFlux = 0;
    for (int index = 0; index < result.value.length; index++) {
      actualFlux += result.value[index] * result.coverage[index];
    }
    expect(actualFlux, closeTo(expectedFlux, 1e-9));
  });

  test('rotation zero matches the axis-aligned path pixel by pixel', () {
    final DrizzleAccumulator axis = DrizzleAccumulator(width: 6, height: 6);
    final DrizzleAccumulator rotated = DrizzleAccumulator(
      width: 6,
      height: 6,
    );
    for (int index = 0; index < 15; index++) {
      final double x = 1.1 + (index * 0.37) % 3.8;
      final double y = 1.2 + (index * 0.53) % 3.6;
      final double value = 1 + index * 0.7;
      final double radius = 0.3 + (index % 5) * 0.08;
      axis.addDrop(x, y, value, dropRadius: radius);
      rotated.addRotatedDrop(
        x,
        y,
        value,
        rotationRadians: 0,
        dropRadius: radius,
      );
    }
    final DrizzleResult expected = axis.finalize();
    final DrizzleResult actual = rotated.finalize();
    for (int index = 0; index < expected.value.length; index++) {
      expect(actual.coverage[index], closeTo(expected.coverage[index], 1e-9));
      expect(actual.value[index], closeTo(expected.value[index], 1e-9));
    }
  });

  test('rotated drops conserve flux across representative angles', () {
    for (final int degrees in <int>[0, 15, 30, 45, 60, 90, 137]) {
      final DrizzleAccumulator accumulator = DrizzleAccumulator(
        width: 6,
        height: 6,
      );
      double expectedFlux = 0;
      for (int index = 0; index < 10; index++) {
        final double value = 1 + index * 0.4;
        accumulator.addRotatedDrop(
          1.6 + (index * 0.29) % 2.8,
          1.7 + (index * 0.41) % 2.6,
          value,
          rotationRadians: degrees * math.pi / 180,
        );
        expectedFlux += value;
      }
      final DrizzleResult result = accumulator.finalize();
      double actualFlux = 0;
      for (int index = 0; index < result.value.length; index++) {
        actualFlux += result.value[index] * result.coverage[index];
      }
      expect(actualFlux, closeTo(expectedFlux, 1e-9), reason: '$degrees°');
    }
  });

  test('45 degree square reaches only edge-adjacent pixels', () {
    final DrizzleResult result = (DrizzleAccumulator(width: 5, height: 5)
          ..addRotatedDrop(2, 2, 8, rotationRadians: math.pi / 4))
        .finalize();
    double at(int x, int y) => result.coverage[y * 5 + x];
    expect(at(2, 2), greaterThan(0));
    for (final (int, int) point in <(int, int)>[
      (1, 2),
      (3, 2),
      (2, 1),
      (2, 3),
    ]) {
      expect(at(point.$1, point.$2), greaterThan(0));
    }
    for (final (int, int) point in <(int, int)>[
      (1, 1),
      (3, 1),
      (1, 3),
      (3, 3),
    ]) {
      expect(at(point.$1, point.$2), closeTo(0, 1e-9));
    }
  });

  test('matches the frozen Node rotated-drop fixture', () {
    final DrizzleResult result = (DrizzleAccumulator(width: 4, height: 3)
          ..addDrop(0.75, 0.25, 8, weight: 1.25)
          ..addRotatedDrop(
            2.1,
            1.2,
            3.5,
            rotationRadians: math.pi / 6,
            dropRadius: 0.6,
            weight: 0.8,
          ))
        .finalize();
    const List<double> expectedValue = <double>[
      8,
      8,
      3.5000000000000004,
      0,
      8,
      7.301545754049996,
      3.5000000000000004,
      3.5,
      0,
      3.5,
      3.5,
      3.5,
    ];
    const List<double> expectedCoverage = <double>[
      0.234375,
      0.703125,
      0.013216985202462528,
      0,
      0.078125,
      0.27743648721743874,
      0.693566029595075,
      0.15274018169510592,
      0,
      0.0014922678357857323,
      0.23801030955228591,
      0.009912738901847008,
    ];
    for (int index = 0; index < expectedValue.length; index++) {
      expect(result.value[index], closeTo(expectedValue[index], 1e-12));
      expect(
        result.coverage[index],
        closeTo(expectedCoverage[index], 1e-12),
      );
    }
  });

  test('non-finite, degenerate, and outside drops contribute nothing', () {
    final DrizzleAccumulator accumulator = DrizzleAccumulator(
      width: 3,
      height: 3,
    )
      ..addDrop(double.nan, 1, 5)
      ..addDrop(1, 1, double.infinity)
      ..addDrop(1, 1, 5, dropRadius: 0)
      ..addRotatedDrop(-20, -20, 5, rotationRadians: math.pi / 6)
      ..addRotatedDrop(1, 1, 5, rotationRadians: double.nan);
    final DrizzleResult result = accumulator.finalize();
    expect(result.coverage.every((double value) => value == 0), isTrue);
  });

  test(
    'addDrops batches multiple samples and skips non-finite entries',
    () {
      final DrizzleAccumulator accumulator = DrizzleAccumulator(
        width: 3,
        height: 3,
      );
      accumulator.addDrops(
        const <DrizzleSample>[
          DrizzleSample(outputX: 1, outputY: 1, value: 5),
          DrizzleSample(outputX: double.nan, outputY: 1, value: 5),
          DrizzleSample(outputX: 1, outputY: 1, value: double.infinity),
          DrizzleSample(outputX: 1, outputY: 1, value: 3, weight: 2),
        ],
        dropRadius: 0.5,
      );
      final DrizzleResult result = accumulator.finalize();
      // 有効な2つの単位面積dropの重み付き平均: (5*1 + 3*2) / (1+2) = 11/3。
      expect(
        (result.value[1 * 3 + 1] - 11 / 3).abs(),
        lessThan(1e-12),
      );
      expect((result.coverage[1 * 3 + 1] - 3).abs(), lessThan(1e-12));
    },
  );

  test('arbitrary mapped quadrilateral preserves its exact footprint area', () {
    final DrizzleAccumulator accumulator = DrizzleAccumulator(
      width: 8,
      height: 8,
    );
    accumulator.addPolygonDrop(
      const <DrizzlePoint>[
        (x: 2.0, y: 2.0),
        (x: 4.0, y: 2.0),
        (x: 4.5, y: 3.0),
        (x: 2.5, y: 3.0),
      ],
      37,
      weight: 0.75,
    );

    final DrizzleResult result = accumulator.finalize();
    final double coverageSum = result.coverage.fold<double>(
      0,
      (double sum, double value) => sum + value,
    );
    expect(coverageSum, closeTo(1.5, 1e-12));
    for (int i = 0; i < result.coverage.length; i++) {
      if (result.coverage[i] > 0) {
        expect(result.value[i], closeTo(37, 1e-12));
      }
    }
  });

  test('allocation-free quadrilateral path matches polygon clipping exactly',
      () {
    final DrizzleAccumulator polygon = DrizzleAccumulator(
      width: 24,
      height: 20,
    );
    final DrizzleAccumulator quadrilateral = DrizzleAccumulator(
      width: 24,
      height: 20,
    );
    for (int index = 0; index < 80; index++) {
      final double centerX = 1.2 + (index % 19) * 1.07;
      final double centerY = 1.4 + ((index * 7) % 16) * 1.03;
      final double angle = (index - 40) * 0.003;
      final double halfWidth = 0.35 + (index % 5) * 0.08;
      final double halfHeight = 0.4 + (index % 3) * 0.06;
      final double cosine = math.cos(angle);
      final double sine = math.sin(angle);
      final List<DrizzlePoint> corners = <DrizzlePoint>[
        (
          x: centerX - halfWidth * cosine + halfHeight * sine,
          y: centerY - halfWidth * sine - halfHeight * cosine,
        ),
        (
          x: centerX + halfWidth * cosine + halfHeight * sine,
          y: centerY + halfWidth * sine - halfHeight * cosine,
        ),
        (
          x: centerX + halfWidth * cosine - halfHeight * sine,
          y: centerY + halfWidth * sine + halfHeight * cosine,
        ),
        (
          x: centerX - halfWidth * cosine - halfHeight * sine,
          y: centerY - halfWidth * sine + halfHeight * cosine,
        ),
      ];
      polygon.addPolygonDrop(corners, index + 1, weight: 0.75);
      quadrilateral.addQuadrilateralDrop(
        corners[0].x,
        corners[0].y,
        corners[1].x,
        corners[1].y,
        corners[2].x,
        corners[2].y,
        corners[3].x,
        corners[3].y,
        index + 1,
        weight: 0.75,
      );
    }
    final DrizzleResult expected = polygon.finalize();
    final DrizzleResult actual = quadrilateral.finalize();
    for (int index = 0; index < expected.value.length; index++) {
      expect(actual.value[index], closeTo(expected.value[index], 1e-12));
      expect(
        actual.coverage[index],
        closeTo(expected.coverage[index], 1e-12),
      );
    }
  });

  test('negative weights never subtract Drizzle coverage', () {
    final DrizzleAccumulator accumulator = DrizzleAccumulator(
      width: 3,
      height: 3,
    )
      ..addDrop(1, 1, 10, weight: -1)
      ..addRotatedDrop(1, 1, 10, weight: -2);
    final DrizzleResult result = accumulator.finalize();
    expect(result.coverage.every((double value) => value == 0), isTrue);
    expect(result.value.every((double value) => value == 0), isTrue);
  });

  test('infinite Drizzle footprint dimensions are skipped safely', () {
    final DrizzleAccumulator accumulator = DrizzleAccumulator(
      width: 3,
      height: 3,
    )
      ..addDrop(1, 1, 10, dropRadius: double.infinity)
      ..addRotatedDrop(
        1,
        1,
        10,
        halfWidth: double.infinity,
        halfHeight: 0.5,
      );
    final DrizzleResult result = accumulator.finalize();
    expect(result.coverage.every((double value) => value == 0), isTrue);
  });
}
