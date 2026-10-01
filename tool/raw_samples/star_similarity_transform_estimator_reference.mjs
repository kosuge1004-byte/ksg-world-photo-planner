/// Reference frame-to-frame similarity (rigid: rotation + translation, no
/// scale) transform estimator for Mobile Stack star registration.
///
/// Consumes two unlabeled star lists (see `star_centroid_detector_
/// reference.mjs`) — one from a reference frame, one from a target frame
/// being aligned to it — and recovers the rotation and translation that
/// maps reference-frame star positions onto their target-frame
/// counterparts, without knowing the correspondence between the two lists
/// in advance and while tolerating some spurious, unmatched, or
/// mismeasured stars (hot pixels the detector missed, a trail fragment,
/// noise-level false positives).
///
/// The output is compatible with `AffineSamplingTransform.similarity`'s
/// constructor parameters: `source = center + R(rotation) * (output -
/// center) + sourceOffset`, i.e. this module answers "where in the
/// target frame does a given reference-frame position land".
///
/// Algorithm, in three stages:
/// 1. Coarse correspondence search, from two independent sources whose
///    hypotheses are pooled together:
///    a. Translation-only hypotheses from pairs of bright stars,
///       assuming zero rotation. Cheap, and sufficient on its own for
///       the small-rotation case (a short handheld/tripod burst).
///    b. Rotation-aware hypotheses from matching pairwise distances
///       between bright stars in each frame — distance between two
///       points is invariant under rotation and translation, so a
///       reference pair and a target pair with matching distance yield a
///       candidate 2-point rigid-transform hypothesis directly, with no
///       zero-rotation assumption. This is what extends the working
///       rotation range well beyond (a) alone (see WORK36_PROGRESS.md's
///       "Known limitation: rotation range").
///    Every hypothesis from both sources whose nearest-neighbor match
///    count clears a floor is kept, not just the single best-scoring
///    one — see the note on step 3.
/// 2. Per-hypothesis refinement: for each surviving coarse hypothesis,
///    iteratively fit a rigid (rotation + translation) transform via the
///    closed-form 2D orthogonal Procrustes solution, re-match at a
///    tighter, rotation-aware tolerance, and repeat until the
///    correspondence set stabilizes.
/// 3. Selection: among the refined hypotheses that meet the minimum
///    inlier count and residual thresholds, keep the one with the most
///    inliers (ties broken by lowest residual). This is the standard
///    RANSAC "generate many hypotheses, score them after fitting, keep
///    the best" structure; scoring only the coarse, pre-refinement stage
///    would let a small lucky coincidence outrank the true, larger
///    correspondence set before rotation is even accounted for.

export class StarTransformEstimationFailed extends Error {
  constructor(message) {
    super(message);
    this.name = 'StarTransformEstimationFailed';
  }
}

export class InvalidStarTransformInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidStarTransformInput';
  }
}

function validateStarList(stars, label) {
  if (!Array.isArray(stars)) {
    throw new InvalidStarTransformInput(`${label} must be an array.`);
  }
  for (const star of stars) {
    if (!Number.isFinite(star.x) || !Number.isFinite(star.y)) {
      throw new InvalidStarTransformInput(
        `${label} entries must have finite x and y.`,
      );
    }
  }
}

/// Builds translation-only hypotheses from all pairs among the top
/// `hypothesisStarCount` brightest stars of each list (assumes lists are
/// already flux-sorted descending, matching `detectStars`'s output), and
/// returns every hypothesis whose rotation-agnostic nearest-neighbor
/// match count is at least `minHypothesisInliers`, sorted by descending
/// match count.
///
/// Returning every promising hypothesis (rather than only the single
/// best-scoring one) matters: at the coarse, rotation-agnostic stage, a
/// real transform with nonzero rotation can score *lower* than an
/// unrelated but coincidentally well-aligned handful of stars, especially
/// once points far from the rotation center are excluded by their
/// rotation-induced coarse-stage error. Refining only the top-scoring
/// coarse hypothesis risks confidently refining a lucky coincidence
/// instead of the true correspondence; refining every plausible
/// hypothesis and then picking the best *refined* result (see
/// `estimateSimilarityTransform`) is the standard RANSAC structure this
/// module follows.
function coarseTranslationHypotheses({
  referenceStars,
  targetStars,
  toleranceRadius,
  hypothesisStarCount,
  minHypothesisInliers,
}) {
  const referenceCandidates = referenceStars.slice(0, hypothesisStarCount);
  const targetCandidates = targetStars.slice(0, hypothesisStarCount);
  const seen = new Set();
  const hypotheses = [];
  for (const reference of referenceCandidates) {
    for (const target of targetCandidates) {
      const dx = target.x - reference.x;
      const dy = target.y - reference.y;
      // Round to dedupe near-identical hypotheses from different star
      // pairs that happen to imply almost the same translation.
      const key = `${Math.round(dx * 4)}:${Math.round(dy * 4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const matches = countNearestNeighborMatches({
        referenceStars,
        targetStars,
        transform: { rotation: 0, dx, dy },
        toleranceRadius,
      });
      if (matches.length >= minHypothesisInliers) {
        hypotheses.push({ dx, dy, inlierCount: matches.length });
      }
    }
  }
  hypotheses.sort((a, b) => b.inlierCount - a.inlierCount);
  return hypotheses;
}

function applyRigidTransform(transform, x, y) {
  const cosine = Math.cos(transform.rotation);
  const sine = Math.sin(transform.rotation);
  return {
    x: cosine * x - sine * y + transform.dx,
    y: sine * x + cosine * y + transform.dy,
  };
}

/// Greedily matches each reference star to its nearest target star (after
/// applying `transform`) within `toleranceRadius`, then resolves
/// many-to-one conflicts by keeping only the closest reference star for
/// each contested target star. Returns the surviving correspondence list.
function countNearestNeighborMatches({
  referenceStars,
  targetStars,
  transform,
  toleranceRadius,
}) {
  const claims = [];
  for (let referenceIndex = 0; referenceIndex < referenceStars.length;
    referenceIndex++) {
    const reference = referenceStars[referenceIndex];
    const predicted = applyRigidTransform(transform, reference.x, reference.y);
    let bestTargetIndex = -1;
    let bestDistance = Infinity;
    for (let targetIndex = 0; targetIndex < targetStars.length;
      targetIndex++) {
      const target = targetStars[targetIndex];
      const distance = Math.hypot(
        target.x - predicted.x,
        target.y - predicted.y,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestTargetIndex = targetIndex;
      }
    }
    if (bestTargetIndex >= 0 && bestDistance <= toleranceRadius) {
      claims.push({ referenceIndex, targetIndex: bestTargetIndex,
        distance: bestDistance });
    }
  }
  claims.sort((a, b) => a.distance - b.distance);
  const claimedTargets = new Set();
  const claimedReferences = new Set();
  const matches = [];
  for (const claim of claims) {
    if (claimedTargets.has(claim.targetIndex)
        || claimedReferences.has(claim.referenceIndex)) {
      continue;
    }
    claimedTargets.add(claim.targetIndex);
    claimedReferences.add(claim.referenceIndex);
    matches.push(claim);
  }
  return matches;
}

/// Closed-form 2D orthogonal Procrustes solution: the rotation and
/// translation minimizing the sum of squared residuals between
/// `R * referencePoint + t` and the matched `targetPoint`, for the given
/// correspondence list.
function fitRigidTransform(referenceStars, targetStars, matches) {
  let referenceCentroidX = 0;
  let referenceCentroidY = 0;
  let targetCentroidX = 0;
  let targetCentroidY = 0;
  for (const match of matches) {
    const reference = referenceStars[match.referenceIndex];
    const target = targetStars[match.targetIndex];
    referenceCentroidX += reference.x;
    referenceCentroidY += reference.y;
    targetCentroidX += target.x;
    targetCentroidY += target.y;
  }
  const n = matches.length;
  referenceCentroidX /= n;
  referenceCentroidY /= n;
  targetCentroidX /= n;
  targetCentroidY /= n;

  let sumCosTerm = 0; // Sxx + Syy
  let sumSinTerm = 0; // Sxy - Syx
  for (const match of matches) {
    const reference = referenceStars[match.referenceIndex];
    const target = targetStars[match.targetIndex];
    const ax = reference.x - referenceCentroidX;
    const ay = reference.y - referenceCentroidY;
    const bx = target.x - targetCentroidX;
    const by = target.y - targetCentroidY;
    sumCosTerm += ax * bx + ay * by;
    sumSinTerm += ax * by - ay * bx;
  }
  const rotation = Math.atan2(sumSinTerm, sumCosTerm);
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const dx = targetCentroidX
    - (cosine * referenceCentroidX - sine * referenceCentroidY);
  const dy = targetCentroidY
    - (sine * referenceCentroidX + cosine * referenceCentroidY);
  return {
    rotation,
    dx,
    dy,
    referenceCentroidX,
    referenceCentroidY,
    targetCentroidX,
    targetCentroidY,
  };
}

function rmsResidual(referenceStars, targetStars, matches, transform) {
  if (matches.length === 0) return 0;
  let sumSquares = 0;
  for (const match of matches) {
    const reference = referenceStars[match.referenceIndex];
    const target = targetStars[match.targetIndex];
    const predicted = applyRigidTransform(transform, reference.x, reference.y);
    const dx = predicted.x - target.x;
    const dy = predicted.y - target.y;
    sumSquares += dx * dx + dy * dy;
  }
  return Math.sqrt(sumSquares / matches.length);
}

/// Iteratively refines a single coarse hypothesis into a rotation-aware
/// rigid fit: refit, re-match at `refinedToleranceRadius`, repeat until
/// the correspondence set stabilizes or `maxRefinementIterations` is
/// reached. Returns `null` if the correspondence set collapses below 2
/// matches (the closed-form fit's mathematical minimum) at any point.
///
/// `coarseTransform` is the starting hypothesis; it may already include a
/// nonzero rotation (as `distancePairHypotheses` produces) or assume zero
/// rotation (as the translation-only `coarseTranslationHypotheses`
/// produces) — either way, the first match pass uses it as given, and
/// every iteration after that re-estimates the full rigid transform from
/// scratch via `fitRigidTransform`.
function refineHypothesis({
  referenceStars,
  targetStars,
  coarseTransform,
  toleranceRadius,
  refinedToleranceRadius,
  maxRefinementIterations,
}) {
  let transform = coarseTransform;
  let matches = countNearestNeighborMatches({
    referenceStars,
    targetStars,
    transform,
    toleranceRadius,
  });

  let previousMatchKey = '';
  for (let iteration = 0; iteration < maxRefinementIterations; iteration++) {
    if (matches.length < 2) return null;
    const fit = fitRigidTransform(referenceStars, targetStars, matches);
    transform = { rotation: fit.rotation, dx: fit.dx, dy: fit.dy };
    const nextMatches = countNearestNeighborMatches({
      referenceStars,
      targetStars,
      transform,
      toleranceRadius: refinedToleranceRadius,
    });
    const matchKey = nextMatches
      .map((match) => `${match.referenceIndex}:${match.targetIndex}`)
      .sort()
      .join(',');
    matches = nextMatches;
    if (matchKey === previousMatchKey) break;
    previousMatchKey = matchKey;
  }
  if (matches.length < 2) return null;

  const finalFit = fitRigidTransform(referenceStars, targetStars, matches);
  const finalTransform = {
    rotation: finalFit.rotation,
    dx: finalFit.dx,
    dy: finalFit.dy,
  };
  const residual = rmsResidual(
    referenceStars,
    targetStars,
    matches,
    finalTransform,
  );
  return { fit: finalFit, matches, residual };
}

/// Builds rotation-aware coarse hypotheses from pairs of bright stars,
/// using the fact that the Euclidean distance between two points is
/// invariant under rotation and translation. For every reference pair
/// (i, j) and target pair (k, l) whose distances agree within
/// `distanceTolerance`, this proposes both possible correspondences
/// (i->k, j->l) and (i->l, j->k) — the pair distance alone can't tell
/// which orientation is correct — and fits the 2-point rigid transform
/// for each. Unlike `coarseTranslationHypotheses`, these hypotheses are
/// not restricted to zero rotation, which is what allows the estimator
/// to recover inter-frame rotations well beyond the translation-only
/// search's range (see WORK36_PROGRESS.md's "Known limitation").
///
/// Pairs closer together than `minPairDistance` are skipped: a short
/// reference segment amplifies ordinary centroiding noise into a large
/// rotation-angle error (the angular error from a fixed positional noise
/// scales roughly as 1/distance), so short pairs produce unstable,
/// low-quality rotation hypotheses that mostly waste refinement attempts.
function distancePairHypotheses({
  referenceStars,
  targetStars,
  hypothesisStarCount,
  distanceTolerance,
  minPairDistance,
}) {
  const referenceCandidates = referenceStars.slice(0, hypothesisStarCount);
  const targetCandidates = targetStars.slice(0, hypothesisStarCount);

  const referencePairs = [];
  for (let i = 0; i < referenceCandidates.length; i++) {
    for (let j = i + 1; j < referenceCandidates.length; j++) {
      const distance = Math.hypot(
        referenceCandidates[i].x - referenceCandidates[j].x,
        referenceCandidates[i].y - referenceCandidates[j].y,
      );
      if (distance < minPairDistance) continue;
      referencePairs.push({ i, j, distance });
    }
  }
  const targetPairs = [];
  for (let k = 0; k < targetCandidates.length; k++) {
    for (let l = k + 1; l < targetCandidates.length; l++) {
      const distance = Math.hypot(
        targetCandidates[k].x - targetCandidates[l].x,
        targetCandidates[k].y - targetCandidates[l].y,
      );
      if (distance < minPairDistance) continue;
      targetPairs.push({ k, l, distance });
    }
  }
  targetPairs.sort((a, b) => a.distance - b.distance);

  const hypotheses = [];
  for (const referencePair of referencePairs) {
    // Binary-search the sorted target pairs for the matching distance
    // band, rather than scanning every target pair against every
    // reference pair.
    let low = 0;
    let high = targetPairs.length;
    const lowerBound = referencePair.distance - distanceTolerance;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (targetPairs[mid].distance < lowerBound) low = mid + 1;
      else high = mid;
    }
    for (let index = low; index < targetPairs.length; index++) {
      const targetPair = targetPairs[index];
      if (targetPair.distance - referencePair.distance > distanceTolerance) {
        break;
      }
      for (const [refFirst, refSecond, targetFirst, targetSecond] of [
        [referencePair.i, referencePair.j, targetPair.k, targetPair.l],
        [referencePair.i, referencePair.j, targetPair.l, targetPair.k],
      ]) {
        const matches = [
          { referenceIndex: refFirst, targetIndex: targetFirst,
            distance: 0 },
          { referenceIndex: refSecond, targetIndex: targetSecond,
            distance: 0 },
        ];
        const fit = fitRigidTransform(referenceStars, targetStars, matches);
        hypotheses.push({
          rotation: fit.rotation,
          dx: fit.dx,
          dy: fit.dy,
        });
      }
    }
  }
  return hypotheses;
}

/// Estimates the rigid (rotation + translation) transform mapping
/// `referenceStars` positions onto `targetStars` positions.
///
/// Both inputs should be arrays of `{x, y, flux}`-like objects sorted by
/// descending flux (as `detectStars` returns), though sorting is not
/// re-validated here beyond using it as a hint for the coarse search.
///
/// Options:
/// - `toleranceRadius` (default 3): matching tolerance, in pixels, used
///   both for the coarse translation-only search and initially for
///   refinement; refinement tightens toward `refinedToleranceRadius`
///   once a rotation-aware estimate is available.
/// - `refinedToleranceRadius` (default `toleranceRadius / 2`, floor 0.75):
///   matching tolerance used for later refinement iterations, once the
///   transform's rotation term is no longer assumed to be zero.
/// - `hypothesisStarCount` (default 12): number of brightest stars from
///   each list used to build coarse translation hypotheses (cost is
///   quadratic in this count).
/// - `minHypothesisInliers` (default `max(2, minInliers - 1)`): a coarse
///   hypothesis is only refined if its rotation-agnostic nearest-neighbor
///   match count reaches this floor, cheaply discarding hypotheses too
///   weak to be worth refining.
/// - `maxHypothesesToRefine` (default 24): caps how many of the
///   best-scoring coarse translation-only hypotheses are actually
///   refined, bounding worst-case cost when many hypotheses clear
///   `minHypothesisInliers`.
/// - `useDistancePairMatching` (default true): also generates
///   rotation-aware coarse hypotheses from pairs of bright stars, using
///   the rotation invariance of pairwise distance. This is what lets the
///   estimator recover rotations beyond what `coarseTranslationHypotheses`
///   alone can resolve (see WORK36_PROGRESS.md's "Known limitation:
///   rotation range"); disable it only if rotation is known to always be
///   negligible and the extra search cost isn't worth it.
/// - `distancePairStarCount` (default 15): number of brightest stars used
///   to build distance-pair hypotheses (cost is quadratic in this count
///   for building pairs, then log-linear for the cross-match).
/// - `distancePairToleranceRadius` (default `2 * toleranceRadius`):
///   how closely a reference pair's and a target pair's distances must
///   agree to be considered a candidate match.
/// - `minPairDistance` (default 20): skips star pairs closer together
///   than this, since a short baseline amplifies ordinary centroiding
///   noise into a large rotation-angle error.
/// - `maxDistancePairHypothesesToRefine` (default 40): caps how many
///   distance-pair hypotheses are refined.
/// - `maxRefinementIterations` (default 6): refit/re-match iteration cap
///   applied to each refined hypothesis.
/// - `minInliers` (default 3): minimum matched-pair count required to
///   accept the result; 2 is the mathematical minimum for a rotation
///   estimate, but 3 gives the closed-form fit some redundancy against a
///   single bad match.
/// - `maxAcceptableRmsResidual` (default 1.5 pixels, independent of
///   `toleranceRadius`): if the final fit's RMS residual exceeds this,
///   the result is rejected. This guards against a specific failure mode
///   of the coarse, rotation-agnostic search: for large inter-frame
///   rotations, it can lock onto a self-consistent but wrong
///   correspondence set (several stars that coincidentally satisfy a
///   translation-only match), which then refines into a plausible-
///   looking transform with a non-trivial residual rather than the
///   near-zero residual a correct fit produces on real, precisely
///   centroided star fields. Rejecting on residual turns that silent
///   misalignment into a loud, catchable failure. The default is a fixed
///   pixel budget rather than a fraction of `toleranceRadius`
///   deliberately: widening `toleranceRadius` to chase a larger rotation
///   must not simultaneously loosen this safety check, which is exactly
///   the situation where a false convergence is most likely.
///
/// Returns `{ rotationDegrees, sourceOffsetX, sourceOffsetY, centerX,
/// centerY, inlierCount, rmsResidual, matches }`, where the first five
/// fields are ready to pass directly to
/// `AffineSamplingTransform.similarity`, `centerX`/`centerY` is the
/// centroid of the reference stars used in the final fit, `matches` is
/// the list of `{referenceIndex, targetIndex, distance}` correspondences
/// that were kept as inliers, and `rmsResidual` is the root-mean-square
/// residual (in pixels) of the final fit over those inliers.
///
/// Throws `StarTransformEstimationFailed` if fewer than `minInliers`
/// correspondences can be found.
export function estimateSimilarityTransform(
  referenceStars,
  targetStars,
  options = {},
) {
  validateStarList(referenceStars, 'referenceStars');
  validateStarList(targetStars, 'targetStars');
  const toleranceRadius = options.toleranceRadius ?? 3;
  const refinedToleranceRadius = options.refinedToleranceRadius
    ?? Math.max(0.75, toleranceRadius / 2);
  const hypothesisStarCount = options.hypothesisStarCount ?? 12;
  const maxRefinementIterations = options.maxRefinementIterations ?? 6;
  const minInliers = options.minInliers ?? 3;
  const maxAcceptableRmsResidual = options.maxAcceptableRmsResidual ?? 1.5;
  // A coarse hypothesis with very few rotation-agnostic matches is both
  // cheap to discard early and, more importantly, a common source of the
  // lucky-coincidence false convergences this module guards against, so
  // hypotheses below this floor are not even attempted.
  const minHypothesisInliers = options.minHypothesisInliers
    ?? Math.max(2, minInliers - 1);
  // Caps how many of the (sorted, best-first) coarse hypotheses are
  // refined, bounding worst-case cost when many hypotheses clear
  // `minHypothesisInliers`.
  const maxHypothesesToRefine = options.maxHypothesesToRefine ?? 24;
  // Distance-pair (rotation-aware) hypothesis search, enabled by default:
  // extends the working rotation range well beyond what the
  // translation-only coarse search can resolve (see
  // WORK36_PROGRESS.md's "Known limitation: rotation range"). Costs
  // O(hypothesisStarCount^2 log(hypothesisStarCount^2)) regardless of
  // whether it ends up finding anything, so it can be disabled for
  // callers that know rotation is always negligible and want to skip the
  // extra work.
  const useDistancePairMatching = options.useDistancePairMatching ?? true;
  const distancePairStarCount = options.distancePairStarCount ?? 15;
  const distancePairToleranceRadius = options.distancePairToleranceRadius
    ?? 2 * toleranceRadius;
  const minPairDistance = options.minPairDistance ?? 20;
  const maxDistancePairHypothesesToRefine = options
    .maxDistancePairHypothesesToRefine ?? 40;

  if (!Number.isFinite(toleranceRadius) ||
      toleranceRadius <= 0 ||
      !Number.isFinite(refinedToleranceRadius) ||
      refinedToleranceRadius <= 0 ||
      !Number.isInteger(hypothesisStarCount) ||
      hypothesisStarCount < 1 ||
      !Number.isInteger(minHypothesisInliers) ||
      minHypothesisInliers < 1 ||
      !Number.isInteger(maxHypothesesToRefine) ||
      maxHypothesesToRefine < 1 ||
      !Number.isInteger(distancePairStarCount) ||
      distancePairStarCount < 2 ||
      !Number.isFinite(distancePairToleranceRadius) ||
      distancePairToleranceRadius <= 0 ||
      !Number.isFinite(minPairDistance) ||
      minPairDistance <= 0 ||
      !Number.isInteger(maxDistancePairHypothesesToRefine) ||
      maxDistancePairHypothesesToRefine < 1 ||
      !Number.isInteger(maxRefinementIterations) ||
      maxRefinementIterations < 1 ||
      !Number.isInteger(minInliers) ||
      minInliers < 2 ||
      !Number.isFinite(maxAcceptableRmsResidual) ||
      maxAcceptableRmsResidual < 0) {
    throw new InvalidStarTransformInput(
      'Star-transform parameters must be finite and within valid ranges.',
    );
  }

  if (referenceStars.length < minInliers || targetStars.length < minInliers) {
    throw new StarTransformEstimationFailed(
      `Need at least ${minInliers} stars in each frame; got `
        + `${referenceStars.length} reference and ${targetStars.length} `
        + 'target.',
    );
  }

  const hypotheses = coarseTranslationHypotheses({
    referenceStars,
    targetStars,
    toleranceRadius,
    hypothesisStarCount,
    minHypothesisInliers,
  });
  const rotationAwareHypotheses = useDistancePairMatching
    ? distancePairHypotheses({
      referenceStars,
      targetStars,
      hypothesisStarCount: distancePairStarCount,
      distanceTolerance: distancePairToleranceRadius,
      minPairDistance,
    })
    : [];
  if (hypotheses.length === 0 && rotationAwareHypotheses.length === 0) {
    throw new StarTransformEstimationFailed(
      'Could not find an initial correspondence hypothesis: the '
        + `translation-only search needs ${minHypothesisInliers} matching `
        + 'stars and found none, and distance-pair matching (if enabled) '
        + 'found no consistent star-pair distances between the two frames.',
    );
  }

  let best = null;
  const tryHypothesis = (coarseTransform) => {
    const refined = refineHypothesis({
      referenceStars,
      targetStars,
      coarseTransform,
      toleranceRadius,
      refinedToleranceRadius,
      maxRefinementIterations,
    });
    if (refined === null) return;
    if (refined.matches.length < minInliers) return;
    if (refined.residual > maxAcceptableRmsResidual) return;
    // Prefer more inliers first (a larger self-consistent correspondence
    // set is much less likely to be a coincidence), then lower residual.
    const isBetter = best === null
      || refined.matches.length > best.matches.length
      || (refined.matches.length === best.matches.length
        && refined.residual < best.residual);
    if (isBetter) best = refined;
  };
  for (const hypothesis of hypotheses.slice(0, maxHypothesesToRefine)) {
    tryHypothesis({ rotation: 0, dx: hypothesis.dx, dy: hypothesis.dy });
  }
  for (const hypothesis of rotationAwareHypotheses.slice(
    0,
    maxDistancePairHypothesesToRefine,
  )) {
    tryHypothesis(hypothesis);
  }

  if (best === null) {
    const attempted = Math.min(hypotheses.length, maxHypothesesToRefine)
      + Math.min(
        rotationAwareHypotheses.length,
        maxDistancePairHypothesesToRefine,
      );
    throw new StarTransformEstimationFailed(
      `Refined ${attempted} coarse hypothesis(es) but none reached `
        + `${minInliers} inliers within a `
        + `${maxAcceptableRmsResidual.toFixed(3)}px RMS residual. The `
        + 'frames may not share a consistent rigid transform, or the '
        + 'rotation may be too large for the current search settings.',
    );
  }

  return {
    rotationDegrees: best.fit.rotation * 180 / Math.PI,
    sourceOffsetX: best.fit.targetCentroidX - best.fit.referenceCentroidX,
    sourceOffsetY: best.fit.targetCentroidY - best.fit.referenceCentroidY,
    centerX: best.fit.referenceCentroidX,
    centerY: best.fit.referenceCentroidY,
    inlierCount: best.matches.length,
    rmsResidual: best.residual,
    matches: best.matches,
  };
}
