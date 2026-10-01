import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/similarity_transform_math.dart';

/// Dart port of the `invertSimilarityTransform is the exact inverse of
/// AffineSamplingTransform.similarity's forward map` test from
/// `tool/raw_samples/test/cfa_drizzle_reference.test.mjs`.

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

/// Reimplements the AffineSamplingTransform.similarity formula directly
/// (matching [applySimilarityForward]'s own documented contract), so the
/// round-trip test below checks [invertSimilarityTransform] against the
/// documented contract rather than against itself -- mirroring the Node
/// reference test's independence check (which similarly reimplements the
/// formula in the test file rather than calling back into the module
/// under test for the forward direction).
({double x, double y}) _similarityForward(
  SimilarityTransformEstimate params,
  double outputX,
  double outputY,
) {
  final double radians = params.rotationDegrees * math.pi / 180;
  final double cosine = math.cos(radians);
  final double sine = math.sin(radians);
  final double ox = outputX - params.centerX;
  final double oy = outputY - params.centerY;
  return (
    x: params.centerX + cosine * ox - sine * oy + params.sourceOffsetX,
    y: params.centerY + sine * ox + cosine * oy + params.sourceOffsetY,
  );
}

void main() {
  test(
    'invertSimilarityTransform is the exact inverse of the documented '
    'similarity forward map',
    () {
      final List<_Estimate> cases = <_Estimate>[
        const _Estimate(
          rotationDegrees: 0,
          sourceOffsetX: 5,
          sourceOffsetY: -3,
          centerX: 50,
          centerY: 40,
        ),
        const _Estimate(
          rotationDegrees: 12.5,
          sourceOffsetX: -2.2,
          sourceOffsetY: 1.1,
          centerX: 100,
          centerY: 80,
        ),
        const _Estimate(
          rotationDegrees: -47,
          sourceOffsetX: 0,
          sourceOffsetY: 0,
          centerX: 0,
          centerY: 0,
        ),
        const _Estimate(
          rotationDegrees: 179.9,
          sourceOffsetX: 10,
          sourceOffsetY: 10,
          centerX: 10,
          centerY: 10,
        ),
      ];
      final List<(double, double)> testPoints = <(double, double)>[
        (0, 0),
        (10.5, -3.2),
        (100, 200),
        (-50, 30),
      ];

      for (final _Estimate params in cases) {
        final ({double x, double y}) Function(double, double) forward =
            invertSimilarityTransform(params);
        for (final (double outputX, double outputY) in testPoints) {
          final ({double x, double y}) source =
              _similarityForward(params, outputX, outputY);
          final ({double x, double y}) recovered = forward(source.x, source.y);
          expect(
            (recovered.x - outputX).abs(),
            lessThan(1e-9),
            reason: 'x: expected $outputX, got ${recovered.x}',
          );
          expect(
            (recovered.y - outputY).abs(),
            lessThan(1e-9),
            reason: 'y: expected $outputY, got ${recovered.y}',
          );
        }
      }
    },
  );

  test('applySimilarityForward and invertSimilarityTransform agree', () {
    // A second, complementary check: applySimilarityForward (the
    // function this module actually exports for the forward direction)
    // and invertSimilarityTransform's returned closure must be exact
    // inverses of each other for the same estimate.
    const _Estimate estimate = _Estimate(
      rotationDegrees: 33,
      sourceOffsetX: 4,
      sourceOffsetY: -6,
      centerX: 20,
      centerY: 20,
    );
    final ({double x, double y}) Function(double, double) inverse =
        invertSimilarityTransform(estimate);
    for (final (double x, double y) in <(double, double)>[
      (0, 0),
      (5, 5),
      (-10, 15),
      (100, -40),
    ]) {
      final ({double x, double y}) forward =
          applySimilarityForward(estimate, x, y);
      final ({double x, double y}) roundTrip = inverse(forward.x, forward.y);
      expect((roundTrip.x - x).abs(), lessThan(1e-9));
      expect((roundTrip.y - y).abs(), lessThan(1e-9));
    }
  });
}
