import 'dart:math' as math;
import 'dart:typed_data';

import '../registration/luminance_plane.dart';

/// Dart port of `tool/raw_samples/gaussian_psf_centroid_refinement_
/// reference.mjs`.
///
/// Addresses S4 of the quality specification this project's stakeholder
/// provided: `star_detector.dart`'s own existing centroiding
/// (`_centroidWindow`) is a plain intensity-weighted centroid, not a
/// PSF fit of any kind, despite the spec's own explicit request for
/// proper PSF fitting.
///
/// This module does **not** replace or modify the existing centroiding
/// at all — it adds a small, independent *refinement* step, taking an
/// already-computed centroid as its own starting point and sharpening
/// it using a **separable Gaussian marginal fit**: sum the window's own
/// pixel values along each row/column to get 1-D profiles, then fit a
/// parabola to the *logarithm* of the three points nearest each
/// profile's own peak (a Gaussian's own logarithm is exactly a
/// parabola, so this closed-form 3-point fit recovers the true
/// sub-pixel peak position without an iterative non-linear solver).
///
/// See the Node reference's own doc comment for the full design
/// rationale, including exactly when refinement is skipped, falling
/// back to the original centroid unchanged (peak at the window's own
/// edge, a non-positive value where a logarithm is needed, or a
/// parabola that does not actually open downward).
///
/// This file has not been executed against the Dart SDK. It is a
/// careful line-by-line translation of the Node reference, which has
/// full test coverage, including a hand-verified numeric case (a true
/// Gaussian profile with `sigma=1.5`, peak at `x0=2.3`) confirming this
/// technique recovers the exact sub-pixel position. Run
/// `test/gaussian_psf_centroid_refinement_test.dart` before relying on
/// this in production.

class InvalidPsfRefinementInput extends ArgumentError {
  InvalidPsfRefinementInput(String super.message);
}

/// A single refined centroid, mirroring the Node reference's own
/// `{x, y}` return shape.
class RefinedCentroid {
  const RefinedCentroid({
    required this.x,
    required this.y,
    this.sigmaX,
    this.sigmaY,
  });

  final double x;
  final double y;

  /// Gaussian sigma (pixels) estimated from the local 3-sample log-parabola
  /// curvature on each marginal profile. `null` means the local samples were
  /// not suitable for a physically meaningful width estimate, even if the
  /// centroid itself could still safely fall back to the incoming value.
  final double? sigmaX;
  final double? sigmaY;
}

final class _AxisGaussianFit {
  const _AxisGaussianFit({required this.position, required this.sigma});

  final double position;
  final double? sigma;
}

double? _parabolicVertexOffset(List<double> logValues) {
  final double left = logValues[0];
  final double center = logValues[1];
  final double right = logValues[2];
  final double denominator = left - 2 * center + right;
  if (denominator >= 0) return null;
  return 0.5 * (left - right) / denominator;
}

/// Refines a single centroid axis: given the window's own [profile] (a
/// list of background-subtracted, non-negative marginal sums, one entry
/// per integer position starting at [profileOriginIndex]) and the
/// existing centroid's own [initialPosition] on this axis, finds the
/// integer index nearest [initialPosition], fits a parabola to the log
/// of that index and its two immediate neighbors, and returns the
/// refined sub-pixel position — or [initialPosition] unchanged if
/// refinement is not possible.
///
/// Throws [InvalidPsfRefinementInput] if [profile] has fewer than 3
/// entries.
_AxisGaussianFit _fitAxisWithGaussianMarginal(
  List<double> profile,
  int profileOriginIndex,
  double initialPosition, {
  int? anchorPosition,
}) {
  if (profile.length < 3) {
    throw InvalidPsfRefinementInput('profile must have at least 3 entries.');
  }
  // The caller may provide the detector's actual integer local maximum as
  // the fitting anchor. Keep the original centroid only as the fallback
  // result: an asymmetric PSF/noisy wing can move the intensity centroid far
  // enough that centroid.round() points at a neighbouring sample, causing the
  // log-parabola to be fit to the wrong three samples.
  final int nearestIndex =
      (anchorPosition ?? initialPosition.round()) - profileOriginIndex;
  if (nearestIndex <= 0 || nearestIndex >= profile.length - 1) {
    return _AxisGaussianFit(position: initialPosition, sigma: null);
  }
  final double left = profile[nearestIndex - 1];
  final double center = profile[nearestIndex];
  final double right = profile[nearestIndex + 1];
  if (!(left > 0) || !(center > 0) || !(right > 0)) {
    return _AxisGaussianFit(position: initialPosition, sigma: null);
  }
  final List<double> logValues = <double>[
    math.log(left),
    math.log(center),
    math.log(right),
  ];
  final double denominator = logValues[0] - 2 * logValues[1] + logValues[2];
  final double? offset = _parabolicVertexOffset(logValues);
  if (offset == null || offset.abs() > 1) {
    return _AxisGaussianFit(position: initialPosition, sigma: null);
  }

  // For log(Gaussian), the second finite difference at unit pixel spacing is
  // exactly -1 / sigma^2. This gives a width estimate from the same three
  // central samples used for centroid refinement, avoiding the noise-floor
  // bias of a wide second-moment window when comparing a noisy source frame
  // with a lower-noise stack.
  final double sigma = math.sqrt(-1 / denominator);
  if (!sigma.isFinite || sigma <= 0) {
    return _AxisGaussianFit(position: initialPosition, sigma: null);
  }
  return _AxisGaussianFit(
    position: (nearestIndex + profileOriginIndex) + offset,
    sigma: sigma,
  );
}

double refineAxisWithGaussianMarginalFit(
  List<double> profile,
  int profileOriginIndex,
  double initialPosition, {
  int? anchorPosition,
}) =>
    _fitAxisWithGaussianMarginal(
      profile,
      profileOriginIndex,
      initialPosition,
      anchorPosition: anchorPosition,
    ).position;

class _MarginalProfiles {
  const _MarginalProfiles({required this.xProfile, required this.yProfile});

  final Float64List xProfile;
  final Float64List yProfile;
}

_MarginalProfiles _computeMarginalProfiles(
  LuminancePlane source,
  int left,
  int right,
  int top,
  int bottom,
  double backgroundMedian,
) {
  final int width = right - left + 1;
  final int height = bottom - top + 1;
  final Float64List xProfile = Float64List(width);
  final Float64List yProfile = Float64List(height);
  for (int y = top; y <= bottom; y++) {
    for (int x = left; x <= right; x++) {
      final double value = math.max(
        0,
        source.sampleAt(x, y) - backgroundMedian,
      );
      xProfile[x - left] += value;
      yProfile[y - top] += value;
    }
  }
  return _MarginalProfiles(xProfile: xProfile, yProfile: yProfile);
}

/// Refines [initialX]/[initialY] (an already-computed centroid) using a
/// separable Gaussian marginal fit over the window
/// `[peakX - windowRadius, peakX + windowRadius] x
/// [peakY - windowRadius, peakY + windowRadius]` (clamped to
/// [source]'s own bounds).
///
/// Returns a [RefinedCentroid], each axis independently either the
/// refined sub-pixel position or the corresponding input position
/// unchanged.
///
/// Throws [InvalidPsfRefinementInput] if [windowRadius] is not a
/// positive integer.
///
/// Unlike the Node reference (which additionally validates [source]'s
/// own sample count against its dimensions), this Dart port has no such
/// check: [LuminancePlane]'s own constructor already enforces that
/// consistency — the same "Node-level validation made unreachable by
/// Dart's own type system" situation this project's other ports have
/// documented before.
RefinedCentroid refineCentroidWithGaussianPsfFit({
  required LuminancePlane source,
  required int peakX,
  required int peakY,
  required double initialX,
  required double initialY,
  required double backgroundMedian,
  required int windowRadius,
}) {
  if (windowRadius < 1) {
    throw InvalidPsfRefinementInput(
      'windowRadius must be a positive integer.',
    );
  }
  if (source.samples.any((double value) => !value.isFinite) ||
      !initialX.isFinite ||
      !initialY.isFinite ||
      !backgroundMedian.isFinite) {
    throw InvalidPsfRefinementInput(
      'PSF refinement requires finite luminance and centroid inputs.',
    );
  }
  if (peakX < 0 ||
      peakY < 0 ||
      peakX >= source.width ||
      peakY >= source.height) {
    throw InvalidPsfRefinementInput(
      'PSF peak coordinates must lie inside the source image.',
    );
  }
  final int left = math.max(0, peakX - windowRadius);
  final int right = math.min(source.width - 1, peakX + windowRadius);
  final int top = math.max(0, peakY - windowRadius);
  final int bottom = math.min(source.height - 1, peakY + windowRadius);

  final _MarginalProfiles profiles = _computeMarginalProfiles(
    source,
    left,
    right,
    top,
    bottom,
    backgroundMedian,
  );

  final _AxisGaussianFit xFit = _fitAxisWithGaussianMarginal(
    profiles.xProfile,
    left,
    initialX,
    anchorPosition: peakX,
  );
  final _AxisGaussianFit yFit = _fitAxisWithGaussianMarginal(
    profiles.yProfile,
    top,
    initialY,
    anchorPosition: peakY,
  );

  return RefinedCentroid(
    x: xFit.position,
    y: yFit.position,
    sigmaX: xFit.sigma,
    sigmaY: yFit.sigma,
  );
}
