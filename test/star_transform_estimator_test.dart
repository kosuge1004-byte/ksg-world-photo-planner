import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/star_transform_estimator.dart';

/// Dart port of
/// `tool/raw_samples/test/star_similarity_transform_estimator_reference.
/// test.mjs`, including the two regression tests for the RANSAC
/// false-convergence bug and the toleranceRadius-independent RMS-residual
/// guard described in WORK36_PROGRESS.md.

final class _Star implements StarPoint {
  const _Star(this.x, this.y);

  @override
  final double x;
  @override
  final double y;
}

_Star _applyGroundTruth(
  _Star star,
  double rotationDegrees,
  double dx,
  double dy,
  double centerX,
  double centerY,
) {
  final double radians = rotationDegrees * math.pi / 180;
  final double cosine = math.cos(radians);
  final double sine = math.sin(radians);
  final double ox = star.x - centerX;
  final double oy = star.y - centerY;
  return _Star(
    centerX + cosine * ox - sine * oy + dx,
    centerY + sine * ox + cosine * oy + dy,
  );
}

List<_Star> _referenceField(
  int count,
  int seed, [
  double width = 200,
  double height = 200,
]) {
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  final List<_Star> stars = <_Star>[];
  for (int i = 0; i < count; i++) {
    stars.add(
      _Star(10 + next() * (width - 20), 10 + next() * (height - 20)),
    );
  }
  return stars;
}

/// Applies the estimate as a forward transform, matching
/// `AffineSamplingTransform.similarity`'s convention, so tests verify the
/// actual public output contract rather than internal fields alone.
({double x, double y}) _applyEstimatedTransform(
  StarSimilarityTransformEstimate estimate,
  double x,
  double y,
) {
  final double radians = estimate.rotationDegrees * math.pi / 180;
  final double cosine = math.cos(radians);
  final double sine = math.sin(radians);
  final double ox = x - estimate.centerX;
  final double oy = y - estimate.centerY;
  return (
    x: estimate.centerX + cosine * ox - sine * oy + estimate.sourceOffsetX,
    y: estimate.centerY + sine * ox + cosine * oy + estimate.sourceOffsetY,
  );
}

void main() {
  test('rejects non-finite star coordinates', () {
    expect(
      () => estimateSimilarityTransform(
        <_Star>[_Star(double.nan, 1)],
        <_Star>[const _Star(1, 1)],
      ),
      throwsA(isA<InvalidStarTransformInput>()),
    );
  });

  test('fails clearly with too few stars', () {
    final List<_Star> reference = _referenceField(2, 1);
    final List<_Star> target = reference
        .map((_Star star) => _applyGroundTruth(star, 0, 5, 5, 0, 0))
        .toList();
    expect(
      () => estimateSimilarityTransform(reference, target),
      throwsA(isA<StarTransformEstimationFailed>()),
    );
  });

  test('recovers a pure translation exactly (noiseless)', () {
    final List<_Star> reference = _referenceField(15, 7);
    final List<_Star> target = reference
        .map((_Star star) => _applyGroundTruth(star, 0, 12.5, -8.25, 0, 0))
        .toList();
    final StarSimilarityTransformEstimate estimate =
        estimateSimilarityTransform(reference, target);
    expect(estimate.rotationDegrees.abs(), lessThan(1e-6));
    expect(estimate.inlierCount, reference.length);
    expect(estimate.rmsResidual, lessThan(1e-6));

    for (int i = 0; i < reference.length; i++) {
      final ({double x, double y}) mapped = _applyEstimatedTransform(
        estimate,
        reference[i].x,
        reference[i].y,
      );
      expect((mapped.x - target[i].x).abs(), lessThan(1e-6));
      expect((mapped.y - target[i].y).abs(), lessThan(1e-6));
    }
  });

  test('recovers a small rotation plus translation exactly (noiseless)', () {
    final List<_Star> reference = _referenceField(20, 21);
    const double centerX = 100;
    const double centerY = 100;
    const double trueRotation = 3.5; // degrees, typical short handheld burst
    const double trueDx = -4.0;
    const double trueDy = 6.5;
    final List<_Star> target = reference
        .map(
          (_Star star) => _applyGroundTruth(
            star,
            trueRotation,
            trueDx,
            trueDy,
            centerX,
            centerY,
          ),
        )
        .toList();
    final StarSimilarityTransformEstimate estimate =
        estimateSimilarityTransform(reference, target);
    expect(
      (estimate.rotationDegrees - trueRotation).abs(),
      lessThan(1e-3),
      reason: 'expected rotation near $trueRotation, got '
          '${estimate.rotationDegrees}',
    );
    expect(estimate.inlierCount, reference.length);
    expect(estimate.rmsResidual, lessThan(1e-6));
  });

  test(
    'recovers a larger rotation typical of a longer static-tripod session',
    () {
      final List<_Star> reference = _referenceField(24, 33);
      const double centerX = 100;
      const double centerY = 100;
      const double trueRotation = 12; // degrees
      const double trueDx = 3;
      const double trueDy = -2;
      final List<_Star> target = reference
          .map(
            (_Star star) => _applyGroundTruth(
              star,
              trueRotation,
              trueDx,
              trueDy,
              centerX,
              centerY,
            ),
          )
          .toList();
      final StarSimilarityTransformEstimate estimate =
          estimateSimilarityTransform(
        reference,
        target,
        toleranceRadius: 20,
      );
      expect(
        (estimate.rotationDegrees - trueRotation).abs(),
        lessThan(1e-2),
        reason: 'expected rotation near $trueRotation, got '
            '${estimate.rotationDegrees}',
      );
      expect(estimate.inlierCount, reference.length);
      expect(estimate.rmsResidual, lessThan(1e-3));
    },
  );

  test('ignores spurious unmatched stars in both lists', () {
    final List<_Star> reference = _referenceField(18, 40);
    const double trueRotation = 2.0;
    const double trueDx = 5;
    const double trueDy = -3;
    final List<_Star> target = reference
        .map(
          (_Star star) => _applyGroundTruth(
            star,
            trueRotation,
            trueDx,
            trueDy,
            100,
            100,
          ),
        )
        .toList();
    final List<_Star> referenceWithOutliers = <_Star>[
      ...reference,
      const _Star(15, 15),
      const _Star(180, 30),
      const _Star(60, 190),
    ];
    final List<_Star> targetWithOutliers = <_Star>[
      ...target,
      const _Star(150, 150),
      const _Star(20, 20),
    ];
    final StarSimilarityTransformEstimate estimate =
        estimateSimilarityTransform(referenceWithOutliers, targetWithOutliers);
    expect(
      (estimate.rotationDegrees - trueRotation).abs(),
      lessThan(1e-2),
      reason: 'expected rotation near $trueRotation, got '
          '${estimate.rotationDegrees}',
    );
    expect(estimate.inlierCount, reference.length);
    expect(estimate.rmsResidual, lessThan(1e-2));
  });

  test(
    'tolerates small centroiding noise without drifting far from truth',
    () {
      final List<_Star> reference = _referenceField(25, 55);
      const double trueRotation = 1.5;
      const double trueDx = 2.2;
      const double trueDy = -1.8;
      int seed = 777;
      double jitter() {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return ((seed / 0x7fffffff) - 0.5) * 0.2; // +/-0.1px centroiding
      }

      final List<_Star> target = reference.map((_Star star) {
        final _Star truth = _applyGroundTruth(
          star,
          trueRotation,
          trueDx,
          trueDy,
          100,
          100,
        );
        return _Star(truth.x + jitter(), truth.y + jitter());
      }).toList();
      final StarSimilarityTransformEstimate estimate =
          estimateSimilarityTransform(reference, target);
      expect(
        (estimate.rotationDegrees - trueRotation).abs(),
        lessThan(0.05),
        reason: 'expected rotation near $trueRotation, got '
            '${estimate.rotationDegrees}',
      );
      expect(estimate.inlierCount, greaterThanOrEqualTo(reference.length - 1));
      expect(estimate.rmsResidual, lessThan(0.5));
    },
  );

  test('fails clearly when the two frames share no consistent transform', () {
    final List<_Star> reference = _referenceField(10, 99);
    final List<_Star> target = _referenceField(10, 4242);
    expect(
      () => estimateSimilarityTransform(reference, target, minInliers: 5),
      throwsA(isA<StarTransformEstimationFailed>()),
    );
  });

  test(
    'with distance-pair matching disabled, the RMS-residual guard rejects '
    'a large-rotation false convergence',
    () {
      // Regression test for the original translation-only-search bug
      // (see WORK36_PROGRESS.md): at large inter-frame rotations, that
      // search alone can lock onto a self-consistent but wrong
      // correspondence set. Distance-pair matching is disabled here
      // specifically to keep exercising the translation-only path's
      // guard in isolation; by default (see the test below), distance-
      // pair matching now solves this case correctly instead — see
      // WORK38_PROGRESS.md.
      final List<_Star> reference = _referenceField(20, 33);
      final List<_Star> target = reference
          .map(
            (_Star star) => _applyGroundTruth(star, 25, 3, -2, 100, 100),
          )
          .toList();
      expect(
        () => estimateSimilarityTransform(
          reference,
          target,
          toleranceRadius: 25,
          useDistancePairMatching: false,
        ),
        throwsA(
          isA<StarTransformEstimationFailed>().having(
            (StarTransformEstimationFailed error) => error.message,
            'message',
            contains('RMS residual'),
          ),
        ),
      );
    },
  );

  test(
    'with distance-pair matching disabled, an explicit looser '
    'maxAcceptableRmsResidual can opt into a worse fit',
    () {
      final List<_Star> reference = _referenceField(20, 33);
      final List<_Star> target = reference
          .map(
            (_Star star) => _applyGroundTruth(star, 25, 3, -2, 100, 100),
          )
          .toList();
      final StarSimilarityTransformEstimate estimate =
          estimateSimilarityTransform(
        reference,
        target,
        toleranceRadius: 25,
        useDistancePairMatching: false,
        maxAcceptableRmsResidual: 100,
      );
      expect(estimate.rmsResidual, greaterThan(1.5));
    },
  );

  test(
    "recovers rotations well beyond the translation-only search's range, "
    'via distance-pair matching (enabled by default)',
    () {
      // Euclidean distance between two points is invariant under
      // rotation and translation, so distance-pair hypotheses need no
      // zero-rotation assumption and no widened toleranceRadius, unlike
      // the translation-only coarse search alone. See
      // WORK38_PROGRESS.md.
      for (final double rotation in <double>[25, 45, 90, 120, 170]) {
        final List<_Star> reference = _referenceField(20, 33);
        final List<_Star> target = reference
            .map(
              (_Star star) =>
                  _applyGroundTruth(star, rotation, 3, -2, 100, 100),
            )
            .toList();
        final StarSimilarityTransformEstimate estimate =
            estimateSimilarityTransform(reference, target);
        expect(
          (estimate.rotationDegrees - rotation).abs(),
          lessThan(1e-6),
          reason: 'rotation=$rotation: expected recovery near truth, got '
              '${estimate.rotationDegrees}',
        );
        expect(estimate.inlierCount, reference.length);
        expect(estimate.rmsResidual, lessThan(1e-6));
      }
    },
  );

  test(
    'distance-pair matching still respects the RMS-residual guard when '
    'frames share no consistent transform',
    () {
      final List<_Star> reference = _referenceField(15, 500);
      final List<_Star> target = _referenceField(15, 6001);
      expect(
        () => estimateSimilarityTransform(reference, target, minInliers: 5),
        throwsA(isA<StarTransformEstimationFailed>()),
      );
    },
  );
  test('release時も非有限・退化transformパラメータを拒否する', () {
    const List<_Star> stars = <_Star>[
      _Star(0, 0),
      _Star(10, 0),
      _Star(0, 10),
    ];
    expect(
      () => estimateSimilarityTransform(
        stars,
        stars,
        toleranceRadius: double.nan,
      ),
      throwsA(isA<InvalidStarTransformInput>()),
    );
    expect(
      () => estimateSimilarityTransform(
        stars,
        stars,
        toleranceRadius: 0,
      ),
      throwsA(isA<InvalidStarTransformInput>()),
    );
    expect(
      () => estimateSimilarityTransform(
        stars,
        stars,
        minInliers: 1,
      ),
      throwsA(isA<InvalidStarTransformInput>()),
    );
  });
}
