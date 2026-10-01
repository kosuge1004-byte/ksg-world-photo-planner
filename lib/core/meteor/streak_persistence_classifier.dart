import 'dart:math' as math;

import '../registration/similarity_transform_math.dart';
import 'streak_shape.dart';

/// Dart port of `tool/raw_samples/streak_persistence_classifier_
/// reference.mjs`.
///
/// `streak_candidate_detector_reference.mjs` finds elongated candidates
/// within a single frame but, by design, does not try to tell a meteor
/// apart from a satellite pass, an aircraft, or another line-shaped
/// artifact. This module adds two signals toward that distinction:
///
/// 1. Cross-frame persistence: a meteor is typically far briefer than a
///    single exposure, so it appears as a streak in exactly *one* frame
///    of a sequence, while a satellite or aircraft crossing a
///    multi-frame sequence over many seconds continues moving between
///    frames and so tends to leave a *matching* streak (similar
///    orientation, plausibly continuing from where the previous one left
///    off) in the immediately adjacent frame(s) too.
/// 2. Sky-motion consistency (requires the optional `skyTransforms`
///    parameter): a persistent streak's cross-frame motion can itself
///    come from two very different causes that the persistence check
///    alone cannot tell apart — a long star trail (a real star, elongated
///    by exposure time, moving *with* the whole star field's rotation)
///    and a satellite or aircraft (moving independently *through* the
///    star field, not tied to its rotation at all). Given the star
///    field's own estimated rigid transform between two frames (from
///    `star_transform_estimator.dart`, run on `star_detector.dart`'s
///    *point*-source detections — a separate detection pass from this
///    module's *streak* detections), a streak whose position transforms
///    correctly under that sky motion is almost certainly part of a
///    star's own trail; one that's persistent but does *not* match the
///    sky's motion is moving independently of the celestial sphere,
///    which a star structurally cannot do — strong evidence of a
///    satellite or aircraft.
///
/// Both signals are real but soft, not a classifier: a meteor that
/// happens to occur during the brief gap between two consecutive
/// exposures, or a very fast/short satellite pass, can look like the
/// "typical" isolated pattern; sky-motion consistency likewise depends
/// on the underlying star registration succeeding for that frame pair.
/// The output is meant to inform the human review step the product is
/// built around, not to silently filter anything out. See also
/// `streak_brightness_profile.dart` for a third, independent signal
/// (blinking navigation lights) that does not depend on cross-frame data
/// at all.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it); it is a careful line-by-line
/// translation of the Node reference, which has full test coverage,
/// including the direction-handling regression test that specifically
/// catches a previous/next transform-inversion mix-up (see
/// WORK42_PROGRESS.md). Run `test/streak_persistence_classifier_test.
/// dart` (mirroring the Node fixtures) before relying on this in
/// production.

class InvalidStreakLinkingInput extends ArgumentError {
  InvalidStreakLinkingInput(super.message);
}

double _normalizeAngle(double radians) {
  // A streak's orientation is a line, not a vector, so angle and
  // angle + pi represent the same direction; normalize into
  // (-pi/2, pi/2] before comparing two streaks' angles.
  double angle = radians % math.pi;
  if (angle > math.pi / 2) angle -= math.pi;
  if (angle <= -math.pi / 2) angle += math.pi;
  return angle;
}

double _angularDistance(double a, double b) {
  // Distance between two orientations on the half-circle (mod pi):
  // handles the branch cut near +/-pi/2 correctly (e.g. angles of +89
  // and -89 degrees are 2 degrees apart, not 178).
  double delta = (_normalizeAngle(a) - _normalizeAngle(b)).abs();
  if (delta > math.pi / 2) delta = math.pi - delta;
  return delta;
}

double _endpointDistance(
  ({double x, double y}) a,
  ({double x, double y}) b,
) =>
    math.sqrt(math.pow(a.x - b.x, 2) + math.pow(a.y - b.y, 2));

/// The smallest distance between any endpoint of [streakA] and any
/// endpoint of [streakB] — a cheap, order-independent proxy for "how
/// close are these two streaks to lining up as a continuation of each
/// other", without needing to know each frame's exact capture timing or
/// gap duration.
double _minimumEndpointGap(StreakGeometry streakA, StreakGeometry streakB) {
  double minimum = double.infinity;
  for (final ({double x, double y}) a in streakA.endpoints) {
    for (final ({double x, double y}) b in streakB.endpoints) {
      final double distance = _endpointDistance(a, b);
      if (distance < minimum) minimum = distance;
    }
  }
  return minimum;
}

/// One frame's worth of streak candidates, in the sequence
/// [classifyStreakPersistence] expects — see that function's doc
/// comment for the "array position, not frameIndex" neighbor semantics.
final class StreakFrame {
  const StreakFrame({required this.frameIndex, required this.streaks});

  final int frameIndex;
  final List<StreakGeometry> streaks;
}

void _validateSkyTransforms(
  List<SimilarityTransformEstimate?>? skyTransforms,
  List<StreakFrame> framesInOrder,
) {
  if (skyTransforms == null) return;
  if (skyTransforms.length != framesInOrder.length - 1) {
    throw InvalidStreakLinkingInput(
      'skyTransforms, when provided, must have exactly '
      "framesInOrder.length - 1 entries: skyTransforms[i] maps "
      "framesInOrder[i]'s stars onto framesInOrder[i + 1]'s stars "
      '(or null for a pair where registration was unavailable).',
    );
  }
}

/// Which neighboring frame(s), if any, a streak links to, and what the
/// sky-motion-consistency check found for each.
enum StreakPersistenceCategory {
  /// No link at all — the classic single-frame meteor pattern, though
  /// see the module doc comment's caveats.
  isolated,

  /// Linked and at least one link matches the star field's motion —
  /// almost certainly a star trail segment, not a real candidate.
  skyMotion,

  /// Linked, sky transform(s) were available, and none matched —
  /// a satellite/aircraft candidate.
  independentMotion,

  /// Linked, but no sky transform was available to test any of the
  /// link(s) against — persistent per the plain cross-frame signal
  /// alone, sky-motion-consistency simply unknown.
  linkedTransformUnavailable,
}

/// One streak's classification result from [classifyStreakPersistence].
final class StreakPersistenceResult {
  const StreakPersistenceResult({
    required this.frameIndex,
    required this.streak,
    required this.persistentAcrossFrames,
    required this.linkedFrameIndices,
    required this.skyConsistentFrameIndices,
    required this.independentMotionFrameIndices,
    required this.category,
  });

  final int frameIndex;
  final StreakGeometry streak;
  final bool persistentAcrossFrames;
  final List<int> linkedFrameIndices;
  final List<int> skyConsistentFrameIndices;
  final List<int> independentMotionFrameIndices;
  final StreakPersistenceCategory category;
}

/// Classifies every streak across [framesInOrder] (sorted by ascending
/// `frameIndex`, gaps allowed — e.g. a frame that yielded no candidates
/// can simply be omitted rather than passed with an empty `streaks`
/// list) by whether a plausibly-continuing streak exists in an adjacent
/// captured frame, and — when [skyTransforms] is supplied — whether that
/// continuation is consistent with the star field's own motion.
///
/// "Adjacent" means the nearest frame before and the nearest frame after
/// in [framesInOrder], by list position, not by `frameIndex` proximity
/// — if frame 5 produced no candidates and was omitted, frame 4 and
/// frame 6 are each other's neighbors for this purpose, which is the
/// right behavior: a satellite's trail simply resumes in whichever frame
/// captured it next, regardless of how many empty frames came between.
///
/// - [maxAngleDifferenceRadians] (default 10 degrees in radians): how
///   closely two streaks' orientations must agree to be considered the
///   same object's continuation.
/// - [maxEndpointGap] (default 40 pixels): the maximum allowed distance
///   between the closest pair of endpoints across the two streaks.
/// - [skyTransforms] (default `null`, disabling the sky-motion-
///   consistency signal entirely): a list of exactly
///   `framesInOrder.length - 1` entries, where `skyTransforms[i]` is the
///   `estimateSimilarityTransform` result mapping `framesInOrder[i]`'s
///   *stars* onto `framesInOrder[i + 1]`'s *stars*, or `null` for a
///   specific pair where star registration was unavailable or failed.
/// - [skyMotionToleranceRadius] (default 8 pixels): how closely a
///   streak's sky-transform-predicted position in a neighboring frame
///   must match that neighbor's actual streak centroid to count as
///   sky-motion-consistent.
///
/// `'skyMotion'` takes priority over `'independentMotion'` when a streak
/// has multiple links with mixed results, since one genuine match to the
/// star field's motion — given how precisely `estimateSimilarityTransform`
/// fits real star fields — is compelling evidence on its own.
List<StreakPersistenceResult> classifyStreakPersistence(
  List<StreakFrame> framesInOrder, {
  double? maxAngleDifferenceRadians,
  double maxEndpointGap = 40,
  List<SimilarityTransformEstimate?>? skyTransforms,
  double skyMotionToleranceRadius = 8,
}) {
  if (framesInOrder.isEmpty) {
    throw InvalidStreakLinkingInput('At least one frame is required.');
  }
  final double effectiveMaxAngleDifferenceRadians =
      maxAngleDifferenceRadians ?? 10 * math.pi / 180;
  _validateSkyTransforms(skyTransforms, framesInOrder);

  bool isLinked(StreakGeometry streakA, StreakGeometry streakB) {
    if (_angularDistance(streakA.angleRadians, streakB.angleRadians) >
        effectiveMaxAngleDifferenceRadians) {
      return false;
    }
    return _minimumEndpointGap(streakA, streakB) <= maxEndpointGap;
  }

  /// Tests whether [streak] (in the frame at [frameOffset]) is
  /// sky-motion-consistent with [neighborStreak] (in the frame at
  /// [neighborOffset], expected to be `frameOffset - 1` or
  /// `frameOffset + 1`). Returns `true`/`false`, or `null` if no sky
  /// transform is available for that pair.
  double? skyResidual(
    StreakGeometry streak,
    int frameOffset,
    StreakGeometry neighborStreak,
    int neighborOffset,
  ) {
    if (skyTransforms == null) return null;
    ({double x, double y}) predicted;
    if (neighborOffset == frameOffset + 1) {
      final SimilarityTransformEstimate? transform = skyTransforms[frameOffset];
      if (transform == null) return null;
      predicted = applySimilarityForward(
        transform,
        streak.centroidX,
        streak.centroidY,
      );
    } else if (neighborOffset == frameOffset - 1) {
      final SimilarityTransformEstimate? transform =
          skyTransforms[neighborOffset];
      if (transform == null) return null;
      final ({double x, double y}) Function(double, double) predictInNeighbor =
          invertSimilarityTransform(transform);
      predicted = predictInNeighbor(streak.centroidX, streak.centroidY);
    } else {
      // Not an immediate array-position neighbor; sky consistency is
      // only evaluated between directly adjacent frames, matching how
      // linking itself works.
      return null;
    }
    final double distance = math.sqrt(
      math.pow(predicted.x - neighborStreak.centroidX, 2) +
          math.pow(predicted.y - neighborStreak.centroidY, 2),
    );
    return distance;
  }

  bool? skyConsistency(StreakGeometry streak, int frameOffset,
      StreakGeometry neighborStreak, int neighborOffset) {
    final double? residual =
        skyResidual(streak, frameOffset, neighborStreak, neighborOffset);
    return residual == null ? null : residual <= skyMotionToleranceRadius;
  }

  StreakGeometry? bestMatch(StreakGeometry streak, int frameOffset,
      StreakFrame neighbor, int neighborOffset) {
    StreakGeometry? best;
    double bestScore = double.infinity;
    bool bestIsStellar = false;
    for (final StreakGeometry candidate in neighbor.streaks) {
      if (!isLinked(streak, candidate)) continue;
      final double? residual =
          skyResidual(streak, frameOffset, candidate, neighborOffset);
      final bool stellar =
          residual != null && residual <= skyMotionToleranceRadius;
      final double score =
          (residual ?? _minimumEndpointGap(streak, candidate)) +
              _angularDistance(streak.angleRadians, candidate.angleRadians) +
              (streak.width - candidate.width).abs();
      // A valid stellar-motion association must not lose to an unrelated
      // continuation simply because that continuation was enumerated first.
      final bool tied = score == bestScore;
      final bool stableTie = best != null &&
          tied &&
          (candidate.centroidX < best.centroidX ||
              (candidate.centroidX == best.centroidX &&
                  candidate.centroidY < best.centroidY));
      if (best == null ||
          (stellar && !bestIsStellar) ||
          (stellar == bestIsStellar && (score < bestScore || stableTie))) {
        best = candidate;
        bestScore = score;
        bestIsStellar = stellar;
      }
    }
    return best;
  }

  final List<StreakPersistenceResult> results = <StreakPersistenceResult>[];
  for (int frameOffset = 0; frameOffset < framesInOrder.length; frameOffset++) {
    final StreakFrame frame = framesInOrder[frameOffset];
    final StreakFrame? previousFrame =
        frameOffset > 0 ? framesInOrder[frameOffset - 1] : null;
    final StreakFrame? nextFrame = frameOffset + 1 < framesInOrder.length
        ? framesInOrder[frameOffset + 1]
        : null;

    for (final StreakGeometry streak in frame.streaks) {
      final List<int> linkedFrameIndices = <int>[];
      final List<int> skyConsistentFrameIndices = <int>[];
      final List<int> independentMotionFrameIndices = <int>[];

      if (previousFrame != null) {
        final StreakGeometry? match =
            bestMatch(streak, frameOffset, previousFrame, frameOffset - 1);
        if (match != null) {
          linkedFrameIndices.add(previousFrame.frameIndex);
          final bool? consistency = skyConsistency(
            streak,
            frameOffset,
            match,
            frameOffset - 1,
          );
          if (consistency == true) {
            skyConsistentFrameIndices.add(previousFrame.frameIndex);
          } else if (consistency == false) {
            independentMotionFrameIndices.add(previousFrame.frameIndex);
          }
        }
      }
      if (nextFrame != null) {
        final StreakGeometry? match =
            bestMatch(streak, frameOffset, nextFrame, frameOffset + 1);
        if (match != null) {
          linkedFrameIndices.add(nextFrame.frameIndex);
          final bool? consistency = skyConsistency(
            streak,
            frameOffset,
            match,
            frameOffset + 1,
          );
          if (consistency == true) {
            skyConsistentFrameIndices.add(nextFrame.frameIndex);
          } else if (consistency == false) {
            independentMotionFrameIndices.add(nextFrame.frameIndex);
          }
        }
      }

      final bool persistentAcrossFrames = linkedFrameIndices.isNotEmpty;
      final StreakPersistenceCategory category;
      if (!persistentAcrossFrames) {
        category = StreakPersistenceCategory.isolated;
      } else if (skyConsistentFrameIndices.isNotEmpty) {
        category = StreakPersistenceCategory.skyMotion;
      } else if (independentMotionFrameIndices.isNotEmpty) {
        category = StreakPersistenceCategory.independentMotion;
      } else {
        category = StreakPersistenceCategory.linkedTransformUnavailable;
      }

      results.add(
        StreakPersistenceResult(
          frameIndex: frame.frameIndex,
          streak: streak,
          persistentAcrossFrames: persistentAcrossFrames,
          linkedFrameIndices: linkedFrameIndices,
          skyConsistentFrameIndices: skyConsistentFrameIndices,
          independentMotionFrameIndices: independentMotionFrameIndices,
          category: category,
        ),
      );
    }
  }
  return results;
}
