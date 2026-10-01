import 'dart:math' as math;

import '../registration/star_detector.dart' show DetectedStar;
import '../registration/star_point.dart' show StarPoint;
import '../registration/star_transform_estimator.dart'
    show
        StarMatch,
        StarSimilarityTransformEstimate,
        StarTransformEstimationFailed,
        estimateSimilarityTransform;

/// How (or whether) the visible gap between consecutive star-trail
/// exposures — caused by the camera's shutter/interval-timer readout time,
/// during which nothing is recorded — should be visually bridged.
///
/// Star trail mode itself performs no frame alignment (see
/// `lighten_blend_combiner.dart`); this only affects the optional
/// gap-filling pass applied after that combine.
enum StarTrailGapFillMode {
  /// No gap filling. Matches every mode's original behavior: trails have
  /// a small break at every shutter interval.
  off,

  /// Connects each star's last position in one frame to its first
  /// position in the next frame with a straight line. Cheap: only needs
  /// per-frame star detection and verified stellar-motion matching.
  /// Visually indistinguishable from the
  /// physically-correct arc for typical sub-few-second gaps, since the
  /// true circular arc's deviation from a straight chord is negligible at
  /// that timescale.
  linear,

  /// Connects each star along the actual circular arc consistent with the
  /// sky's apparent rotation, using the same rotation-center/angle fit
  /// used for frame registration elsewhere in this app (see
  /// `star_transform_estimator.dart`). More accurate for long gaps or
  /// wide-angle/fisheye framing where the arc's curvature is visible, at
  /// the cost of running a full similarity-transform estimation per
  /// consecutive frame pair (comparable cost to the Milky Way mode's own
  /// registration step — see the cost discussion the maintainer approved
  /// before this was implemented).
  arc,
}

/// One drawable gap-fill segment: a short arc (or straight line, when
/// [centerX]/[centerY] are null) from ([startX], [startY]) to ([endX],
/// [endY]), carrying the brightness to paint along it.
final class GapFillSegment {
  const GapFillSegment({
    required this.startX,
    required this.startY,
    required this.endX,
    required this.endY,
    required this.brightness,
    this.centerX,
    this.centerY,
  });

  final double startX;
  final double startY;
  final double endX;
  final double endY;

  /// Rotation center in image space, if this segment should be drawn as
  /// an arc around it. Null for a straight line.
  final double? centerX;
  final double? centerY;

  /// Peak linear-light sample value to paint along the segment, matching
  /// the fainter of the two matched stars' [DetectedStar.peakValue] (the
  /// gap segment should not be brighter than either endpoint).
  final double brightness;

  /// Returns sample points along this segment, spaced roughly
  /// [maxStepPixels] apart (arc length, not chord length, for arcs), from
  /// (but not including) the start point up to and including the end
  /// point. For a straight line this is trivial; for an arc it walks the
  /// angle in equal steps around ([centerX], [centerY]).
  List<(double, double)> samplePoints({double maxStepPixels = 2}) {
    final double? cx = centerX;
    final double? cy = centerY;
    if (cx == null || cy == null) {
      final double dx = endX - startX;
      final double dy = endY - startY;
      final double length = math.sqrt(dx * dx + dy * dy);
      final int steps = math.max(1, (length / maxStepPixels).ceil());
      return <(double, double)>[
        for (int i = 1; i <= steps; i++)
          (startX + dx * i / steps, startY + dy * i / steps),
      ];
    }
    final double startAngle = math.atan2(startY - cy, startX - cx);
    double endAngle = math.atan2(endY - cy, endX - cx);
    final double startRadius = math.sqrt(
      (startX - cx) * (startX - cx) + (startY - cy) * (startY - cy),
    );
    // Keep endAngle on the same side (shortest rotation) as the fitted
    // transform's rotation direction would imply. The caller already
    // picked the correct branch when constructing the segment (see
    // [_arcSegmentsFromTransform]), so here we only need the arc length
    // for step count, using the *shorter* angular distance is wrong in
    // general (a >180 degree gap is astronomically implausible for a
    // single shutter interval), so no unwrapping beyond +/-pi is done.
    double deltaAngle = endAngle - startAngle;
    while (deltaAngle > math.pi) {
      deltaAngle -= 2 * math.pi;
    }
    while (deltaAngle < -math.pi) {
      deltaAngle += 2 * math.pi;
    }
    endAngle = startAngle + deltaAngle;
    final double arcLength = startRadius * deltaAngle.abs();
    final int steps = math.max(1, (arcLength / maxStepPixels).ceil());
    return <(double, double)>[
      for (int i = 1; i <= steps; i++)
        (
          cx + startRadius * math.cos(startAngle + deltaAngle * i / steps),
          cy + startRadius * math.sin(startAngle + deltaAngle * i / steps),
        ),
    ];
  }
}

/// Solves for the true fixed point of the rotation+translation described
/// by [estimate] (i.e. the point that maps to itself), which is the
/// physically meaningful rotation center (the projected celestial pole,
/// for a fixed tripod) — not [estimate.centerX]/[estimate.centerY], which
/// is only the numerically-convenient pivot the fit was parametrized
/// around (see `similarity_transform_math.dart`'s doc comment on
/// `SimilarityTransformEstimate`).
///
/// `source = center + R(theta) * (output - center) + offset`. Setting
/// `source == output == fixedPoint` and solving:
/// `fixedPoint - center - offset = R(theta) * (fixedPoint - center)`
/// `=> (I - R(theta)) * d = offset`, where `d = fixedPoint - center`.
/// Returns null if `theta` is too close to zero for this to be solvable
/// (near-zero rotation between the two frames — in that case a straight
/// line is visually indistinguishable from the true arc anyway).
(double, double)? _rotationFixedPoint(
  StarSimilarityTransformEstimate estimate,
) {
  final double theta = estimate.rotationDegrees * math.pi / 180.0;
  if (theta.abs() < 1e-6) return null;
  final double cosT = math.cos(theta);
  final double sinT = math.sin(theta);
  // (I - R) = [[1-cosT, sinT], [-sinT, 1-cosT]]
  final double a = 1 - cosT;
  final double b = sinT;
  final double c = -sinT;
  final double d = 1 - cosT;
  final double det = a * d - b * c;
  if (det.abs() < 1e-9) return null;
  final double ox = estimate.sourceOffsetX;
  final double oy = estimate.sourceOffsetY;
  final double dx = (d * ox - b * oy) / det;
  final double dy = (-c * ox + a * oy) / det;
  return (estimate.centerX + dx, estimate.centerY + dy);
}

/// Computes the gap-fill segments to draw between two consecutive
/// star-trail exposures. [starsBefore] must be stars detected in the
/// earlier frame, [starsAfter] in the immediately following frame. Both
/// should be built from full-resolution star detection on each frame
/// (the same detector used elsewhere in this app — see
/// `star_detector.dart`).
///
/// For [StarTrailGapFillMode.arc], if a rotation could not be estimated
/// (e.g. too few matched stars, or the frames are effectively unrotated),
/// this silently falls back to [StarTrailGapFillMode.linear]'s straight
/// segments rather than throwing — a missing/failed arc fit should never
/// abort the whole star-trail export, only degrade this one gap to a
/// straight line.
List<GapFillSegment> computeGapFillSegments({
  required List<DetectedStar> starsBefore,
  required List<DetectedStar> starsAfter,
  required StarTrailGapFillMode mode,
  void Function(String reason)? reportDiagnostic,
}) {
  if (mode == StarTrailGapFillMode.off) return const [];
  StarSimilarityTransformEstimate estimate;
  try {
    estimate = estimateSimilarityTransform(
        starsBefore.cast<StarPoint>(), starsAfter.cast<StarPoint>());
  } on StarTransformEstimationFailed catch (error) {
    // No nearest-neighbor fallback: an uncertain synthetic line must not join
    // different stars. Original observed RGB remains untouched.
    reportDiagnostic?.call(
        'Gap fill omitted: stellar motion could not be verified: $error');
    return const [];
  }
  final center =
      mode == StarTrailGapFillMode.arc ? _rotationFixedPoint(estimate) : null;
  return [
    for (final StarMatch match in estimate.matches)
      GapFillSegment(
        startX: starsBefore[match.referenceIndex].x,
        startY: starsBefore[match.referenceIndex].y,
        endX: starsAfter[match.targetIndex].x,
        endY: starsAfter[match.targetIndex].y,
        centerX: center?.$1,
        centerY: center?.$2,
        brightness: math.min(starsBefore[match.referenceIndex].peakValue,
            starsAfter[match.targetIndex].peakValue),
      ),
  ];
}
