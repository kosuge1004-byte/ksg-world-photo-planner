import 'dart:math' as math;

import 'similarity_transform_math.dart' show SimilarityTransformEstimate;
import 'star_point.dart';

export 'star_point.dart' show StarPoint;

/// Dart port of
/// `tool/raw_samples/star_similarity_transform_estimator_reference.mjs`.
///
/// Consumes two unlabeled star lists (see `star_detector.dart`) — one
/// from a reference frame, one from a target frame being aligned to it —
/// and recovers the rotation and translation that maps reference-frame
/// star positions onto their target-frame counterparts, without knowing
/// the correspondence between the two lists in advance and while
/// tolerating some spurious, unmatched, or mismeasured stars (hot pixels
/// the detector missed, a trail fragment, noise-level false positives).
///
/// The output is compatible with `AffineSamplingTransform.similarity`'s
/// constructor parameters: `source = center + R(rotation) * (output -
/// center) + sourceOffset`, i.e. this module answers "where in the
/// target frame does a given reference-frame position land".
///
/// See the Node reference module's doc comment for the full algorithm
/// description (translation-only *and* rotation-aware distance-pair
/// coarse hypothesis search, per-hypothesis rigid-fit refinement,
/// RANSAC-style selection by inlier count then residual) and
/// WORK36_PROGRESS.md / WORK38_PROGRESS.md for the correctness bugs found
/// and fixed while developing it, all of which this port carries
/// forward: the eigenvalue-based (not axis-difference) roundness gate
/// lives in `star_detector.dart`; the "refine every promising
/// hypothesis, not just the single best-scoring one" structure, the
/// `toleranceRadius`-independent RMS-residual guard, and the
/// rotation-invariant distance-pair hypothesis search (which extends the
/// working rotation range from about 20 degrees to effectively
/// unbounded) are implemented here.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it); it is a careful line-by-line
/// translation of the Node reference, which has full test coverage,
/// including the two RANSAC/false-convergence regression tests. Run
/// `test/star_similarity_transform_estimator_test.dart` (mirroring the
/// Node fixtures) before relying on this in production.

class StarTransformEstimationFailed implements Exception {
  StarTransformEstimationFailed(this.message);

  final String message;

  @override
  String toString() => 'StarTransformEstimationFailed: $message';
}

class InvalidStarTransformInput extends ArgumentError {
  InvalidStarTransformInput(super.message);
}

class _RigidTransform {
  const _RigidTransform({
    required this.rotation,
    required this.dx,
    required this.dy,
  });

  final double rotation;
  final double dx;
  final double dy;
}

class _RigidFit {
  const _RigidFit({
    required this.rotation,
    required this.dx,
    required this.dy,
    required this.referenceCentroidX,
    required this.referenceCentroidY,
    required this.targetCentroidX,
    required this.targetCentroidY,
  });

  final double rotation;
  final double dx;
  final double dy;
  final double referenceCentroidX;
  final double referenceCentroidY;
  final double targetCentroidX;
  final double targetCentroidY;
}

/// A kept correspondence between `referenceStars[referenceIndex]` and
/// `targetStars[targetIndex]`, with the post-transform residual distance
/// (in pixels) that was used to select it.
final class StarMatch {
  const StarMatch({
    required this.referenceIndex,
    required this.targetIndex,
    required this.distance,
  });

  final int referenceIndex;
  final int targetIndex;
  final double distance;
}

/// The result of [estimateSimilarityTransform]: ready to pass directly to
/// `AffineSamplingTransform.similarity`'s [rotationDegrees],
/// [sourceOffsetX], [sourceOffsetY], [centerX], and [centerY] parameters.
/// [centerX]/[centerY] is the centroid of the reference stars used in the
/// final fit. [matches] is the list of kept inlier correspondences, and
/// [rmsResidual] is the root-mean-square residual (in pixels) of the
/// final fit over those inliers.
final class StarSimilarityTransformEstimate
    implements SimilarityTransformEstimate {
  const StarSimilarityTransformEstimate({
    required this.rotationDegrees,
    required this.sourceOffsetX,
    required this.sourceOffsetY,
    required this.centerX,
    required this.centerY,
    required this.inlierCount,
    required this.rmsResidual,
    required this.matches,
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
  final int inlierCount;
  final double rmsResidual;
  final List<StarMatch> matches;
}

class _Hypothesis {
  const _Hypothesis({
    required this.dx,
    required this.dy,
    required this.inlierCount,
  });

  final double dx;
  final double dy;
  final int inlierCount;
}

class _RefinedHypothesis {
  const _RefinedHypothesis({
    required this.fit,
    required this.matches,
    required this.residual,
  });

  final _RigidFit fit;
  final List<StarMatch> matches;
  final double residual;
}

void _validateStarList(List<StarPoint> stars, String label) {
  for (final StarPoint star in stars) {
    if (!star.x.isFinite || !star.y.isFinite) {
      throw InvalidStarTransformInput(
        '$label entries must have finite x and y.',
      );
    }
  }
}

/// Builds translation-only hypotheses from all pairs among the top
/// [hypothesisStarCount] brightest stars of each list (assumes lists are
/// already flux-sorted descending, matching `detectStars`'s output), and
/// returns every hypothesis whose rotation-agnostic nearest-neighbor
/// match count is at least [minHypothesisInliers], sorted by descending
/// match count.
List<_Hypothesis> _coarseTranslationHypotheses({
  required List<StarPoint> referenceStars,
  required List<StarPoint> targetStars,
  required double toleranceRadius,
  required int hypothesisStarCount,
  required int minHypothesisInliers,
}) {
  final List<StarPoint> referenceCandidates =
      referenceStars.take(hypothesisStarCount).toList();
  final List<StarPoint> targetCandidates =
      targetStars.take(hypothesisStarCount).toList();
  final Set<String> seen = <String>{};
  final List<_Hypothesis> hypotheses = <_Hypothesis>[];
  for (final StarPoint reference in referenceCandidates) {
    for (final StarPoint target in targetCandidates) {
      final double dx = target.x - reference.x;
      final double dy = target.y - reference.y;
      // Round to dedupe near-identical hypotheses from different star
      // pairs that happen to imply almost the same translation.
      final String key = '${(dx * 4).round()}:${(dy * 4).round()}';
      if (seen.contains(key)) continue;
      seen.add(key);
      final List<StarMatch> matches = _countNearestNeighborMatches(
        referenceStars: referenceStars,
        targetStars: targetStars,
        transform: _RigidTransform(rotation: 0, dx: dx, dy: dy),
        toleranceRadius: toleranceRadius,
      );
      if (matches.length >= minHypothesisInliers) {
        hypotheses.add(
          _Hypothesis(dx: dx, dy: dy, inlierCount: matches.length),
        );
      }
    }
  }
  hypotheses.sort(
    (_Hypothesis a, _Hypothesis b) => b.inlierCount.compareTo(a.inlierCount),
  );
  return hypotheses;
}

({double x, double y}) _applyRigidTransform(
  _RigidTransform transform,
  double x,
  double y,
) {
  final double cosine = math.cos(transform.rotation);
  final double sine = math.sin(transform.rotation);
  return (
    x: cosine * x - sine * y + transform.dx,
    y: sine * x + cosine * y + transform.dy,
  );
}

/// Greedily matches each reference star to its nearest target star (after
/// applying [transform]) within [toleranceRadius], then resolves
/// many-to-one conflicts by keeping only the closest reference star for
/// each contested target star. Returns the surviving correspondence list.
List<StarMatch> _countNearestNeighborMatches({
  required List<StarPoint> referenceStars,
  required List<StarPoint> targetStars,
  required _RigidTransform transform,
  required double toleranceRadius,
}) {
  final List<StarMatch> claims = <StarMatch>[];
  for (int referenceIndex = 0;
      referenceIndex < referenceStars.length;
      referenceIndex++) {
    final StarPoint reference = referenceStars[referenceIndex];
    final ({double x, double y}) predicted =
        _applyRigidTransform(transform, reference.x, reference.y);
    int bestTargetIndex = -1;
    double bestDistance = double.infinity;
    for (int targetIndex = 0; targetIndex < targetStars.length; targetIndex++) {
      final StarPoint target = targetStars[targetIndex];
      final double distance = math.sqrt(
        math.pow(target.x - predicted.x, 2) +
            math.pow(target.y - predicted.y, 2),
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestTargetIndex = targetIndex;
      }
    }
    if (bestTargetIndex >= 0 && bestDistance <= toleranceRadius) {
      claims.add(
        StarMatch(
          referenceIndex: referenceIndex,
          targetIndex: bestTargetIndex,
          distance: bestDistance,
        ),
      );
    }
  }
  claims.sort(
    (StarMatch a, StarMatch b) => a.distance.compareTo(b.distance),
  );
  final Set<int> claimedTargets = <int>{};
  final Set<int> claimedReferences = <int>{};
  final List<StarMatch> matches = <StarMatch>[];
  for (final StarMatch claim in claims) {
    if (claimedTargets.contains(claim.targetIndex) ||
        claimedReferences.contains(claim.referenceIndex)) {
      continue;
    }
    claimedTargets.add(claim.targetIndex);
    claimedReferences.add(claim.referenceIndex);
    matches.add(claim);
  }
  return matches;
}

/// Closed-form 2D orthogonal Procrustes solution: the rotation and
/// translation minimizing the sum of squared residuals between
/// `R * referencePoint + t` and the matched target point, for the given
/// correspondence list. Requires at least one match.
_RigidFit _fitRigidTransform(
  List<StarPoint> referenceStars,
  List<StarPoint> targetStars,
  List<StarMatch> matches,
) {
  double referenceCentroidX = 0;
  double referenceCentroidY = 0;
  double targetCentroidX = 0;
  double targetCentroidY = 0;
  for (final StarMatch match in matches) {
    final StarPoint reference = referenceStars[match.referenceIndex];
    final StarPoint target = targetStars[match.targetIndex];
    referenceCentroidX += reference.x;
    referenceCentroidY += reference.y;
    targetCentroidX += target.x;
    targetCentroidY += target.y;
  }
  final int n = matches.length;
  referenceCentroidX /= n;
  referenceCentroidY /= n;
  targetCentroidX /= n;
  targetCentroidY /= n;

  double sumCosTerm = 0; // Sxx + Syy
  double sumSinTerm = 0; // Sxy - Syx
  for (final StarMatch match in matches) {
    final StarPoint reference = referenceStars[match.referenceIndex];
    final StarPoint target = targetStars[match.targetIndex];
    final double ax = reference.x - referenceCentroidX;
    final double ay = reference.y - referenceCentroidY;
    final double bx = target.x - targetCentroidX;
    final double by = target.y - targetCentroidY;
    sumCosTerm += ax * bx + ay * by;
    sumSinTerm += ax * by - ay * bx;
  }
  final double rotation = math.atan2(sumSinTerm, sumCosTerm);
  final double cosine = math.cos(rotation);
  final double sine = math.sin(rotation);
  final double dx = targetCentroidX -
      (cosine * referenceCentroidX - sine * referenceCentroidY);
  final double dy = targetCentroidY -
      (sine * referenceCentroidX + cosine * referenceCentroidY);
  return _RigidFit(
    rotation: rotation,
    dx: dx,
    dy: dy,
    referenceCentroidX: referenceCentroidX,
    referenceCentroidY: referenceCentroidY,
    targetCentroidX: targetCentroidX,
    targetCentroidY: targetCentroidY,
  );
}

double _rmsResidual(
  List<StarPoint> referenceStars,
  List<StarPoint> targetStars,
  List<StarMatch> matches,
  _RigidTransform transform,
) {
  if (matches.isEmpty) return 0;
  double sumSquares = 0;
  for (final StarMatch match in matches) {
    final StarPoint reference = referenceStars[match.referenceIndex];
    final StarPoint target = targetStars[match.targetIndex];
    final ({double x, double y}) predicted =
        _applyRigidTransform(transform, reference.x, reference.y);
    final double dx = predicted.x - target.x;
    final double dy = predicted.y - target.y;
    sumSquares += dx * dx + dy * dy;
  }
  return math.sqrt(sumSquares / matches.length);
}

/// Iteratively refines a single coarse hypothesis into a rotation-aware
/// rigid fit: refit, re-match at [refinedToleranceRadius], repeat until
/// the correspondence set stabilizes or [maxRefinementIterations] is
/// reached. Returns `null` if the correspondence set collapses below 2
/// matches (the closed-form fit's mathematical minimum) at any point.
///
/// [coarseTransform] is the starting hypothesis; it may already include a
/// nonzero rotation (as [_distancePairHypotheses] produces) or assume
/// zero rotation (as the translation-only [_coarseTranslationHypotheses]
/// produces) — either way, the first match pass uses it as given, and
/// every iteration after that re-estimates the full rigid transform from
/// scratch via [_fitRigidTransform].
_RefinedHypothesis? _refineHypothesis({
  required List<StarPoint> referenceStars,
  required List<StarPoint> targetStars,
  required _RigidTransform coarseTransform,
  required double toleranceRadius,
  required double refinedToleranceRadius,
  required int maxRefinementIterations,
}) {
  _RigidTransform transform = coarseTransform;
  List<StarMatch> matches = _countNearestNeighborMatches(
    referenceStars: referenceStars,
    targetStars: targetStars,
    transform: transform,
    toleranceRadius: toleranceRadius,
  );

  String previousMatchKey = '';
  for (int iteration = 0; iteration < maxRefinementIterations; iteration++) {
    if (matches.length < 2) return null;
    final _RigidFit fit =
        _fitRigidTransform(referenceStars, targetStars, matches);
    transform = _RigidTransform(rotation: fit.rotation, dx: fit.dx, dy: fit.dy);
    final List<StarMatch> nextMatches = _countNearestNeighborMatches(
      referenceStars: referenceStars,
      targetStars: targetStars,
      transform: transform,
      toleranceRadius: refinedToleranceRadius,
    );
    final List<String> matchKeyParts = nextMatches
        .map(
          (StarMatch match) => '${match.referenceIndex}:${match.targetIndex}',
        )
        .toList()
      ..sort();
    final String matchKey = matchKeyParts.join(',');
    matches = nextMatches;
    if (matchKey == previousMatchKey) break;
    previousMatchKey = matchKey;
  }
  if (matches.length < 2) return null;

  final _RigidFit finalFit =
      _fitRigidTransform(referenceStars, targetStars, matches);
  final _RigidTransform finalTransform = _RigidTransform(
    rotation: finalFit.rotation,
    dx: finalFit.dx,
    dy: finalFit.dy,
  );
  final double residual = _rmsResidual(
    referenceStars,
    targetStars,
    matches,
    finalTransform,
  );
  return _RefinedHypothesis(
    fit: finalFit,
    matches: matches,
    residual: residual,
  );
}

class _StarPairDistance {
  const _StarPairDistance({
    required this.first,
    required this.second,
    required this.distance,
  });

  final int first;
  final int second;
  final double distance;
}

/// Builds rotation-aware coarse hypotheses from pairs of bright stars,
/// using the fact that the Euclidean distance between two points is
/// invariant under rotation and translation. For every reference pair
/// (i, j) and target pair (k, l) whose distances agree within
/// [distanceTolerance], this proposes both possible correspondences
/// (i->k, j->l) and (i->l, j->k) — the pair distance alone can't tell
/// which orientation is correct — and fits the 2-point rigid transform
/// for each. Unlike [_coarseTranslationHypotheses], these hypotheses are
/// not restricted to zero rotation, which is what allows the estimator
/// to recover inter-frame rotations well beyond the translation-only
/// search's range (see WORK36_PROGRESS.md's "Known limitation", since
/// resolved by this addition — see WORK38_PROGRESS.md).
///
/// Pairs closer together than [minPairDistance] are skipped: a short
/// reference segment amplifies ordinary centroiding noise into a large
/// rotation-angle error (the angular error from a fixed positional noise
/// scales roughly as 1/distance), so short pairs produce unstable,
/// low-quality rotation hypotheses that mostly waste refinement attempts.
List<_RigidTransform> _distancePairHypotheses({
  required List<StarPoint> referenceStars,
  required List<StarPoint> targetStars,
  required int hypothesisStarCount,
  required double distanceTolerance,
  required double minPairDistance,
}) {
  final List<StarPoint> referenceCandidates =
      referenceStars.take(hypothesisStarCount).toList();
  final List<StarPoint> targetCandidates =
      targetStars.take(hypothesisStarCount).toList();

  final List<_StarPairDistance> referencePairs = <_StarPairDistance>[];
  for (int i = 0; i < referenceCandidates.length; i++) {
    for (int j = i + 1; j < referenceCandidates.length; j++) {
      final double distance = math.sqrt(
        math.pow(referenceCandidates[i].x - referenceCandidates[j].x, 2) +
            math.pow(referenceCandidates[i].y - referenceCandidates[j].y, 2),
      );
      if (distance < minPairDistance) continue;
      referencePairs.add(
        _StarPairDistance(first: i, second: j, distance: distance),
      );
    }
  }
  final List<_StarPairDistance> targetPairs = <_StarPairDistance>[];
  for (int k = 0; k < targetCandidates.length; k++) {
    for (int l = k + 1; l < targetCandidates.length; l++) {
      final double distance = math.sqrt(
        math.pow(targetCandidates[k].x - targetCandidates[l].x, 2) +
            math.pow(targetCandidates[k].y - targetCandidates[l].y, 2),
      );
      if (distance < minPairDistance) continue;
      targetPairs.add(
        _StarPairDistance(first: k, second: l, distance: distance),
      );
    }
  }
  targetPairs.sort(
    (_StarPairDistance a, _StarPairDistance b) =>
        a.distance.compareTo(b.distance),
  );

  final List<_RigidTransform> hypotheses = <_RigidTransform>[];
  for (final _StarPairDistance referencePair in referencePairs) {
    // Binary-search the sorted target pairs for the matching distance
    // band, rather than scanning every target pair against every
    // reference pair.
    int low = 0;
    int high = targetPairs.length;
    final double lowerBound = referencePair.distance - distanceTolerance;
    while (low < high) {
      final int mid = (low + high) >> 1;
      if (targetPairs[mid].distance < lowerBound) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    for (int index = low; index < targetPairs.length; index++) {
      final _StarPairDistance targetPair = targetPairs[index];
      if (targetPair.distance - referencePair.distance > distanceTolerance) {
        break;
      }
      for (final (int targetFirst, int targetSecond) in <(int, int)>[
        (targetPair.first, targetPair.second),
        (targetPair.second, targetPair.first),
      ]) {
        final List<StarMatch> matches = <StarMatch>[
          StarMatch(
            referenceIndex: referencePair.first,
            targetIndex: targetFirst,
            distance: 0,
          ),
          StarMatch(
            referenceIndex: referencePair.second,
            targetIndex: targetSecond,
            distance: 0,
          ),
        ];
        final _RigidFit fit =
            _fitRigidTransform(referenceStars, targetStars, matches);
        hypotheses.add(
          _RigidTransform(rotation: fit.rotation, dx: fit.dx, dy: fit.dy),
        );
      }
    }
  }
  return hypotheses;
}

/// Estimates the rigid (rotation + translation) transform mapping
/// [referenceStars] positions onto [targetStars] positions.
///
/// Both inputs should be sorted by descending flux (as `detectStars`
/// returns), though sorting is not re-validated here beyond using it as
/// a hint for the coarse search.
///
/// - [toleranceRadius] (default 3): matching tolerance, in pixels, used
///   both for the coarse translation-only search and initially for
///   refinement; refinement tightens toward [refinedToleranceRadius]
///   once a rotation-aware estimate is available.
/// - [refinedToleranceRadius] (default `toleranceRadius / 2`, floor
///   0.75): matching tolerance used for later refinement iterations,
///   once the transform's rotation term is no longer assumed to be zero.
/// - [hypothesisStarCount] (default 12): number of brightest stars from
///   each list used to build coarse translation hypotheses (cost is
///   quadratic in this count).
/// - [minHypothesisInliers] (default `max(2, minInliers - 1)`): a coarse
///   hypothesis is only refined if its rotation-agnostic nearest-neighbor
///   match count reaches this floor.
/// - [maxHypothesesToRefine] (default 24): caps how many of the
///   best-scoring coarse translation-only hypotheses are actually
///   refined.
/// - [useDistancePairMatching] (default true): also generates
///   rotation-aware coarse hypotheses from pairs of bright stars, using
///   the rotation invariance of pairwise distance. This is what lets the
///   estimator recover rotations beyond what translation-only hypotheses
///   alone can resolve (see WORK36_PROGRESS.md's "Known limitation:
///   rotation range", since resolved by this addition — see
///   WORK38_PROGRESS.md); disable it only if rotation is known to always
///   be negligible and the extra search cost isn't worth it.
/// - [distancePairStarCount] (default 15): number of brightest stars
///   used to build distance-pair hypotheses.
/// - [distancePairToleranceRadius] (default `2 * toleranceRadius`): how
///   closely a reference pair's and a target pair's distances must agree
///   to be considered a candidate match.
/// - [minPairDistance] (default 20): skips star pairs closer together
///   than this, since a short baseline amplifies ordinary centroiding
///   noise into a large rotation-angle error.
/// - [maxDistancePairHypothesesToRefine] (default 40): caps how many
///   distance-pair hypotheses are refined.
/// - [maxRefinementIterations] (default 6): refit/re-match iteration cap
///   applied to each refined hypothesis.
/// - [minInliers] (default 3): minimum matched-pair count required to
///   accept the result.
/// - [maxAcceptableRmsResidual] (default 1.5 pixels, independent of
///   [toleranceRadius]): if the final fit's RMS residual exceeds this,
///   the result is rejected. See the module doc comment and
///   WORK36_PROGRESS.md for why this must not scale with
///   `toleranceRadius`.
///
/// Throws [StarTransformEstimationFailed] if no hypothesis reaches
/// [minInliers] correspondences within [maxAcceptableRmsResidual].
StarSimilarityTransformEstimate estimateSimilarityTransform(
  List<StarPoint> referenceStars,
  List<StarPoint> targetStars, {
  double toleranceRadius = 3,
  double? refinedToleranceRadius,
  int hypothesisStarCount = 12,
  int? minHypothesisInliers,
  int maxHypothesesToRefine = 24,
  bool useDistancePairMatching = true,
  int distancePairStarCount = 15,
  double? distancePairToleranceRadius,
  double minPairDistance = 20,
  int maxDistancePairHypothesesToRefine = 40,
  int maxRefinementIterations = 6,
  int minInliers = 3,
  double maxAcceptableRmsResidual = 1.5,
}) {
  _validateStarList(referenceStars, 'referenceStars');
  _validateStarList(targetStars, 'targetStars');
  if (!toleranceRadius.isFinite ||
      toleranceRadius <= 0 ||
      (refinedToleranceRadius != null &&
          (!refinedToleranceRadius.isFinite || refinedToleranceRadius <= 0)) ||
      hypothesisStarCount < 1 ||
      (minHypothesisInliers != null && minHypothesisInliers < 1) ||
      maxHypothesesToRefine < 1 ||
      distancePairStarCount < 2 ||
      (distancePairToleranceRadius != null &&
          (!distancePairToleranceRadius.isFinite ||
              distancePairToleranceRadius <= 0)) ||
      !minPairDistance.isFinite ||
      minPairDistance <= 0 ||
      maxDistancePairHypothesesToRefine < 1 ||
      maxRefinementIterations < 1 ||
      minInliers < 2 ||
      !maxAcceptableRmsResidual.isFinite ||
      maxAcceptableRmsResidual < 0) {
    throw InvalidStarTransformInput(
      'Star-transform parameters must be finite and within valid ranges.',
    );
  }
  final double effectiveRefinedToleranceRadius =
      refinedToleranceRadius ?? math.max(0.75, toleranceRadius / 2);
  final int effectiveMinHypothesisInliers =
      minHypothesisInliers ?? math.max(2, minInliers - 1);
  final double effectiveDistancePairToleranceRadius =
      distancePairToleranceRadius ?? 2 * toleranceRadius;

  if (referenceStars.length < minInliers || targetStars.length < minInliers) {
    throw StarTransformEstimationFailed(
      'Need at least $minInliers stars in each frame; got '
      '${referenceStars.length} reference and ${targetStars.length} '
      'target.',
    );
  }

  final List<_Hypothesis> hypotheses = _coarseTranslationHypotheses(
    referenceStars: referenceStars,
    targetStars: targetStars,
    toleranceRadius: toleranceRadius,
    hypothesisStarCount: hypothesisStarCount,
    minHypothesisInliers: effectiveMinHypothesisInliers,
  );
  final List<_RigidTransform> rotationAwareHypotheses = useDistancePairMatching
      ? _distancePairHypotheses(
          referenceStars: referenceStars,
          targetStars: targetStars,
          hypothesisStarCount: distancePairStarCount,
          distanceTolerance: effectiveDistancePairToleranceRadius,
          minPairDistance: minPairDistance,
        )
      : const <_RigidTransform>[];
  if (hypotheses.isEmpty && rotationAwareHypotheses.isEmpty) {
    throw StarTransformEstimationFailed(
      'Could not find an initial correspondence hypothesis: the '
      'translation-only search needs $effectiveMinHypothesisInliers '
      'matching stars and found none, and distance-pair matching (if '
      'enabled) found no consistent star-pair distances between the two '
      'frames.',
    );
  }

  _RefinedHypothesis? best;
  void tryHypothesis(_RigidTransform coarseTransform) {
    final _RefinedHypothesis? refined = _refineHypothesis(
      referenceStars: referenceStars,
      targetStars: targetStars,
      coarseTransform: coarseTransform,
      toleranceRadius: toleranceRadius,
      refinedToleranceRadius: effectiveRefinedToleranceRadius,
      maxRefinementIterations: maxRefinementIterations,
    );
    if (refined == null) return;
    if (refined.matches.length < minInliers) return;
    if (refined.residual > maxAcceptableRmsResidual) return;
    // Prefer more inliers first (a larger self-consistent correspondence
    // set is much less likely to be a coincidence), then lower residual.
    final bool isBetter = best == null ||
        refined.matches.length > best!.matches.length ||
        (refined.matches.length == best!.matches.length &&
            refined.residual < best!.residual);
    if (isBetter) best = refined;
  }

  for (final _Hypothesis hypothesis in hypotheses.take(maxHypothesesToRefine)) {
    tryHypothesis(
      _RigidTransform(rotation: 0, dx: hypothesis.dx, dy: hypothesis.dy),
    );
  }
  for (final _RigidTransform hypothesis in rotationAwareHypotheses.take(
    maxDistancePairHypothesesToRefine,
  )) {
    tryHypothesis(hypothesis);
  }

  if (best == null) {
    final int attempted = math.min(hypotheses.length, maxHypothesesToRefine) +
        math.min(
          rotationAwareHypotheses.length,
          maxDistancePairHypothesesToRefine,
        );
    throw StarTransformEstimationFailed(
      'Refined $attempted coarse hypothesis(es) but none reached '
      '$minInliers inliers within a '
      '${maxAcceptableRmsResidual.toStringAsFixed(3)}px RMS residual. The '
      'frames may not share a consistent rigid transform, or the '
      'rotation may be too large for the current search settings.',
    );
  }

  final _RefinedHypothesis result = best!;
  final double rotationDegrees = result.fit.rotation * 180 / math.pi;
  final double sourceOffsetX =
      result.fit.targetCentroidX - result.fit.referenceCentroidX;
  final double sourceOffsetY =
      result.fit.targetCentroidY - result.fit.referenceCentroidY;
  if (!rotationDegrees.isFinite ||
      !sourceOffsetX.isFinite ||
      !sourceOffsetY.isFinite ||
      !result.fit.referenceCentroidX.isFinite ||
      !result.fit.referenceCentroidY.isFinite ||
      !result.residual.isFinite) {
    throw StarTransformEstimationFailed(
      'Estimated star transform contains non-finite parameters.',
    );
  }
  return StarSimilarityTransformEstimate(
    rotationDegrees: rotationDegrees,
    sourceOffsetX: sourceOffsetX,
    sourceOffsetY: sourceOffsetY,
    centerX: result.fit.referenceCentroidX,
    centerY: result.fit.referenceCentroidY,
    inlierCount: result.matches.length,
    rmsResidual: result.residual,
    matches: result.matches,
  );
}
