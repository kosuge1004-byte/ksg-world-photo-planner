/// Reference cross-frame streak persistence classifier for Mobile
/// Stack's meteor mode.
///
/// `streak_candidate_detector_reference.mjs` finds elongated candidates
/// within a single frame but, by design, does not try to tell a meteor
/// apart from a satellite pass, an aircraft, or another line-shaped
/// artifact — see that module's doc comment. This module adds two
/// signals toward that distinction:
///
/// 1. Cross-frame persistence: a meteor is typically far briefer than a
///    single exposure, so it appears as a streak in exactly *one* frame
///    of a sequence, while a satellite or aircraft crossing a
///    multi-frame sequence over many seconds continues moving between
///    frames and so tends to leave a *matching* streak (similar
///    orientation, plausibly continuing from where the previous one left
///    off) in the immediately adjacent frame(s) too.
/// 2. Sky-motion consistency (requires the optional `skyTransforms`
///    option): a persistent streak's cross-frame motion can itself come
///    from two very different causes that the persistence check alone
///    cannot tell apart — a long star trail (a real star, elongated by
///    exposure time, moving *with* the whole star field's rotation) and
///    a satellite or aircraft (moving independently *through* the star
///    field, not tied to its rotation at all). Given the star field's
///    own estimated rigid transform between two frames (from
///    `star_similarity_transform_estimator_reference.mjs`, run on
///    `star_centroid_detector_reference.mjs`'s *point*-source detections
///    — a separate detection pass from this module's *streak*
///    detections), a streak whose position transforms correctly under
///    that sky motion is almost certainly part of a star's own trail;
///    one that's persistent but does *not* match the sky's motion is
///    moving independently of the celestial sphere, which a star
///    structurally cannot do — strong evidence of a satellite or
///    aircraft.
///
/// Both signals are real but soft, not a classifier: a meteor that
/// happens to occur during the brief gap between two consecutive
/// exposures, or a very fast/short satellite pass, can look like the
/// "typical" isolated pattern; sky-motion consistency likewise depends
/// on the underlying star registration succeeding for that frame pair.
/// The output is meant to inform the human review step the product is
/// built around (sort candidates, or pre-deselect likely-persistent
/// and/or likely-sky-motion candidates), not to silently filter anything
/// out. See also `streak_brightness_profile_reference.mjs` for a third,
/// independent signal (blinking navigation lights) that does not depend
/// on cross-frame data at all.

import { invertSimilarityTransform }
  from './cfa_drizzle_reference.mjs';

export class InvalidStreakLinkingInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidStreakLinkingInput';
  }
}

function normalizeAngle(radians) {
  // A streak's orientation is a line, not a vector (see
  // streak_candidate_detector_reference.mjs's StreakCandidate doc
  // comment), so angle and angle + pi represent the same direction;
  // normalize into (-pi/2, pi/2] before comparing two streaks' angles.
  let angle = radians % Math.PI;
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle <= -Math.PI / 2) angle += Math.PI;
  return angle;
}

function angularDistance(a, b) {
  // Distance between two orientations on the half-circle (mod pi):
  // handles the branch cut near +/-pi/2 correctly (e.g. angles of
  // +89 and -89 degrees are 2 degrees apart, not 178).
  let delta = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  if (delta > Math.PI / 2) delta = Math.PI - delta;
  return delta;
}

function endpointDistance(pointA, pointB) {
  return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
}

/// The smallest distance between any endpoint of `streakA` and any
/// endpoint of `streakB` — a cheap, order-independent proxy for "how
/// close are these two streaks to lining up as a continuation of each
/// other", without needing to know each frame's exact capture timing or
/// gap duration.
function minimumEndpointGap(streakA, streakB) {
  let minimum = Infinity;
  for (const a of streakA.endpoints) {
    for (const b of streakB.endpoints) {
      const distance = endpointDistance(a, b);
      if (distance < minimum) minimum = distance;
    }
  }
  return minimum;
}

function validateFrames(framesInOrder) {
  if (!Array.isArray(framesInOrder) || framesInOrder.length === 0) {
    throw new InvalidStreakLinkingInput('At least one frame is required.');
  }
  for (const frame of framesInOrder) {
    if (!Number.isInteger(frame.frameIndex)
        || !Array.isArray(frame.streaks)) {
      throw new InvalidStreakLinkingInput(
        'Each frame needs an integer frameIndex and a streaks array.',
      );
    }
  }
}

function validateSkyTransforms(skyTransforms, framesInOrder) {
  if (skyTransforms === null) return;
  if (!Array.isArray(skyTransforms)
      || skyTransforms.length !== framesInOrder.length - 1) {
    throw new InvalidStreakLinkingInput(
      'skyTransforms, when provided, must have exactly '
        + 'framesInOrder.length - 1 entries: skyTransforms[i] maps '
        + 'framesInOrder[i]\'s stars onto framesInOrder[i + 1]\'s stars '
        + '(or null for a pair where registration was unavailable).',
    );
  }
}

/// Applies a rigid transform in `AffineSamplingTransform.similarity`'s
/// parameter shape (`source = center + R(rotation) * (output - center) +
/// sourceOffset`, exactly `star_similarity_transform_estimator_
/// reference.mjs`'s output shape) to a point, in the forward
/// (reference/output -> target/source) direction. Reimplemented here
/// (not imported) because it is the small, already-doubly-validated
/// formula itself (matching both `AffineSamplingTransform.similarity`'s
/// documented contract and `cfa_drizzle_reference.test.mjs`'s
/// independent reimplementation of it), unlike `invertSimilarityTransform`
/// below, which is a nontrivial derived computation worth sharing a
/// single tested implementation of rather than re-deriving.
function applySimilarityForward(estimate, x, y) {
  const radians = estimate.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const ox = x - estimate.centerX;
  const oy = y - estimate.centerY;
  return {
    x: estimate.centerX + cosine * ox - sine * oy + estimate.sourceOffsetX,
    y: estimate.centerY + sine * ox + cosine * oy + estimate.sourceOffsetY,
  };
}

/// Classifies every streak across `framesInOrder` (an array of `{
/// frameIndex, streaks }`, sorted by ascending `frameIndex`, gaps
/// allowed — e.g. a frame that yielded no candidates can simply be
/// omitted rather than passed with an empty `streaks` array) by whether
/// a plausibly-continuing streak exists in an adjacent captured frame,
/// and — when `skyTransforms` is supplied — whether that continuation is
/// consistent with the star field's own motion.
///
/// "Adjacent" means the nearest frame before and the nearest frame after
/// in `framesInOrder`, by array position, not by `frameIndex` proximity
/// — if frame 5 produced no candidates and was omitted, frame 4 and
/// frame 6 are each other's neighbors for this purpose, which is the
/// right behavior: a satellite's trail simply resumes in whichever frame
/// captured it next, regardless of how many empty frames came between.
///
/// Options:
/// - `maxAngleDifferenceRadians` (default `10 * pi / 180`, 10 degrees):
///   how closely two streaks' orientations must agree to be considered
///   the same object's continuation.
/// - `maxEndpointGap` (default 40 pixels): the maximum allowed distance
///   between the closest pair of endpoints across the two streaks. Tune
///   based on the frame's resolution and the inter-frame gap duration
///   relative to typical satellite angular velocity.
/// - `skyTransforms` (default `null`, disabling the sky-motion-
///   consistency signal entirely): an array of exactly
///   `framesInOrder.length - 1` entries, where `skyTransforms[i]` is the
///   `estimateSimilarityTransform` result mapping `framesInOrder[i]`'s
///   *stars* onto `framesInOrder[i + 1]`'s *stars* (from a separate
///   point-source detection pass — see `star_centroid_detector_
///   reference.mjs` — not this module's streak detections), or `null`
///   for a specific pair where star registration was unavailable or
///   failed. Providing this activates the `category`,
///   `skyConsistentFrameIndices`, and `independentMotionFrameIndices`
///   fields described below.
/// - `skyMotionToleranceRadius` (default 8 pixels): how closely a
///   streak's sky-transform-predicted position in a neighboring frame
///   must match that neighbor's actual streak centroid to count as
///   sky-motion-consistent. Deliberately looser than the sub-pixel
///   precision `star_similarity_transform_estimator_reference.mjs`
///   itself achieves on point sources (see its own tests), since a
///   streak's centroid comes from whole-region shape analysis over a
///   feature that moved *during* its own frame's exposure, not a single
///   sharp point.
///
/// Returns an array, one entry per input streak (flattened across all
/// frames, in the same relative order), of:
/// - `frameIndex`, `streak`: as given.
/// - `persistentAcrossFrames`: whether any adjacent-frame link was found
///   at all (the Work41 signal, unchanged).
/// - `linkedFrameIndices`: which neighboring frame(s) contributed a
///   link.
/// - `skyConsistentFrameIndices`: the subset of `linkedFrameIndices`
///   where the link's position also matched the star field's own
///   estimated motion — strong evidence this streak is part of a star's
///   own trail, not an independently moving object. Empty whenever
///   `skyTransforms` isn't supplied.
/// - `independentMotionFrameIndices`: the subset of `linkedFrameIndices`
///   where a sky transform *was* available for that pair but the
///   predicted position did *not* match — evidence the streak is moving
///   independently of the celestial sphere (a satellite or aircraft).
///   Empty whenever `skyTransforms` isn't supplied.
/// - `category`: one of `'isolated'` (no link at all — the classic
///   single-frame meteor pattern, though see the module doc comment's
///   caveats), `'skyMotion'` (linked and at least one link matches the
///   star field's motion — almost certainly a star trail segment, not a
///   real candidate), `'independentMotion'` (linked, sky transform(s)
///   were available, and none matched — a satellite/aircraft candidate),
///   or `'linkedTransformUnavailable'` (linked, but no sky transform was
///   available to test any of the link(s) against — persistent per the
///   Work41 signal alone, sky-motion-consistency simply unknown).
///   `'skyMotion'` takes priority over `'independentMotion'` when a
///   streak has multiple links with mixed results, since one genuine
///   match to the star field's motion — given how precisely
///   `estimateSimilarityTransform` fits real star fields (see its own
///   tests) — is compelling evidence on its own.
export function classifyStreakPersistence(framesInOrder, options = {}) {
  validateFrames(framesInOrder);
  const maxAngleDifferenceRadians = options.maxAngleDifferenceRadians
    ?? 10 * Math.PI / 180;
  const maxEndpointGap = options.maxEndpointGap ?? 40;
  const skyTransforms = options.skyTransforms ?? null;
  const skyMotionToleranceRadius = options.skyMotionToleranceRadius ?? 8;
  validateSkyTransforms(skyTransforms, framesInOrder);

  function isLinked(streakA, streakB) {
    if (angularDistance(streakA.angleRadians, streakB.angleRadians)
        > maxAngleDifferenceRadians) {
      return false;
    }
    return minimumEndpointGap(streakA, streakB) <= maxEndpointGap;
  }

  /// Tests whether `streak` (in the frame at `frameOffset`) is
  /// sky-motion-consistent with `neighborStreak` (in the frame at
  /// `neighborOffset`, expected to be `frameOffset - 1` or `frameOffset
  /// + 1`). Returns `true`/`false`, or `null` if no sky transform is
  /// available for that pair.
  function skyResidual(streak, frameOffset, neighborStreak, neighborOffset) {
    if (skyTransforms === null) return null;
    let predicted;
    if (neighborOffset === frameOffset + 1) {
      const transform = skyTransforms[frameOffset];
      if (transform === null) return null;
      predicted = applySimilarityForward(
        transform, streak.centroidX, streak.centroidY,
      );
    } else if (neighborOffset === frameOffset - 1) {
      const transform = skyTransforms[neighborOffset];
      if (transform === null) return null;
      const predictInNeighbor = invertSimilarityTransform(transform);
      predicted = predictInNeighbor(streak.centroidX, streak.centroidY);
    } else {
      // Not an immediate array-position neighbor; sky consistency is
      // only evaluated between directly adjacent frames, matching how
      // linking itself works.
      return null;
    }
    const distance = Math.hypot(
      predicted.x - neighborStreak.centroidX,
      predicted.y - neighborStreak.centroidY,
    );
    return distance;
  }

  function skyConsistency(streak, frameOffset, candidate, neighborOffset) {
    const residual = skyResidual(streak, frameOffset, candidate, neighborOffset);
    return residual === null ? null : residual <= skyMotionToleranceRadius;
  }
  function bestMatch(streak, frameOffset, neighbor, neighborOffset) {
    let best;
    let bestScore = Infinity;
    let bestIsStellar = false;
    for (const candidate of neighbor.streaks) {
      if (!isLinked(streak, candidate)) continue;
      const residual = skyResidual(streak, frameOffset, candidate, neighborOffset);
      const stellar = residual !== null && residual <= skyMotionToleranceRadius;
      const score = (residual ?? minimumEndpointGap(streak, candidate)) +
        angularDistance(streak.angleRadians, candidate.angleRadians) + Math.abs(streak.width - candidate.width);
      const stableTie = best !== undefined && score === bestScore &&
        (candidate.centroidX < best.centroidX || (candidate.centroidX === best.centroidX && candidate.centroidY < best.centroidY));
      if (best === undefined || (stellar && !bestIsStellar) ||
          (stellar === bestIsStellar && (score < bestScore || stableTie))) {
        best = candidate; bestScore = score; bestIsStellar = stellar;
      }
    }
    return best;
  }
  const results = [];
  for (let frameOffset = 0; frameOffset < framesInOrder.length;
    frameOffset++) {
    const frame = framesInOrder[frameOffset];
    const previousFrame = framesInOrder[frameOffset - 1] ?? null;
    const nextFrame = framesInOrder[frameOffset + 1] ?? null;

    for (const streak of frame.streaks) {
      const linkedFrameIndices = [];
      const skyConsistentFrameIndices = [];
      const independentMotionFrameIndices = [];

      if (previousFrame !== null) {
        const match = bestMatch(streak, frameOffset, previousFrame, frameOffset - 1);
        if (match !== undefined) {
          linkedFrameIndices.push(previousFrame.frameIndex);
          const consistency = skyConsistency(
            streak, frameOffset, match, frameOffset - 1,
          );
          if (consistency === true) {
            skyConsistentFrameIndices.push(previousFrame.frameIndex);
          } else if (consistency === false) {
            independentMotionFrameIndices.push(previousFrame.frameIndex);
          }
        }
      }
      if (nextFrame !== null) {
        const match = bestMatch(streak, frameOffset, nextFrame, frameOffset + 1);
        if (match !== undefined) {
          linkedFrameIndices.push(nextFrame.frameIndex);
          const consistency = skyConsistency(
            streak, frameOffset, match, frameOffset + 1,
          );
          if (consistency === true) {
            skyConsistentFrameIndices.push(nextFrame.frameIndex);
          } else if (consistency === false) {
            independentMotionFrameIndices.push(nextFrame.frameIndex);
          }
        }
      }

      const persistentAcrossFrames = linkedFrameIndices.length > 0;
      let category;
      if (!persistentAcrossFrames) {
        category = 'isolated';
      } else if (skyConsistentFrameIndices.length > 0) {
        category = 'skyMotion';
      } else if (independentMotionFrameIndices.length > 0) {
        category = 'independentMotion';
      } else {
        category = 'linkedTransformUnavailable';
      }

      results.push({
        frameIndex: frame.frameIndex,
        streak,
        persistentAcrossFrames,
        linkedFrameIndices,
        skyConsistentFrameIndices,
        independentMotionFrameIndices,
        category,
      });
    }
  }
  return results;
}
