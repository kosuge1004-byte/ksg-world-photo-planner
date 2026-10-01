import 'dart:math' as math;
import 'dart:typed_data';

import 'gaussian_psf_centroid_refinement.dart';
import 'luminance_plane.dart';
import 'star_point.dart';

export 'star_point.dart' show StarPoint;

/// Dart port of `tool/raw_samples/star_centroid_detector_reference.mjs`.
///
/// Finds point-like bright sources in a [LuminancePlane] (typically a
/// demosaiced green channel, or a luminance proxy built from RGB) and
/// reports sub-pixel centroids suitable for frame-to-frame
/// similarity-transform estimation.
///
/// The detector is intentionally conservative and dependency-free: a
/// robust (median/MAD) background estimate, local-maximum candidate
/// selection with non-maximum suppression, intensity-weighted sub-pixel
/// centroiding, and a small set of shape checks (minimum extent, rough
/// roundness) to reject single hot pixels and elongated non-star blobs
/// such as satellite or aircraft trails.
///
/// This is a first pass: it does not attempt full PSF fitting, does not
/// deblend overlapping sources, and its roundness/sharpness checks are
/// coarse. See WORK36_PROGRESS.md for known limitations.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it); it is a careful line-by-line
/// translation of the Node reference, which has full test coverage. Run
/// `test/star_centroid_detector_test.dart` (mirroring the Node fixtures)
/// before relying on this in production.

class InvalidStarDetectionInput extends ArgumentError {
  InvalidStarDetectionInput(super.message);
}

/// A detected point source.
///
/// [x] and [y] are sub-pixel centroid coordinates in the same pixel grid
/// as the input plane (0,0 at the center of the top-left pixel).
/// [flux] is the background-subtracted intensity sum used as the
/// centroiding weight, a convenient (not photometrically calibrated)
/// brightness proxy for ranking and matching.
/// [peakValue] is the raw (not background-subtracted) value of the
/// brightest pixel in the source, useful for saturation checks upstream.
/// [roundness] is a rotation-invariant elongation measure derived from
/// the eigenvalues of the windowed second-moment matrix; 0 is a
/// perfectly round source and values approach 1 for a strongly elongated
/// one (e.g. a satellite trail, at any orientation).
/// [sharpness] is the fraction of the window's background-subtracted
/// flux contributed by the immediate 3x3 neighborhood of the peak; an
/// isolated single hot pixel scores near 1, while a real
/// several-pixel-wide stellar PSF scores lower.
final class DetectedStar implements StarPoint {
  const DetectedStar({
    required this.x,
    required this.y,
    required this.flux,
    required this.peakValue,
    required this.roundness,
    required this.sharpness,
    this.psfFwhmPx,
  });

  @override
  final double x;
  @override
  final double y;
  final double flux;
  final double peakValue;
  final double roundness;
  final double sharpness;

  /// PSF width estimated from the Gaussian marginal fit's local curvature.
  /// This is the FWHM of an equivalent circular Gaussian whose variance is
  /// the mean of the fitted x/y marginal variances. It is intentionally
  /// nullable: when the three central marginal samples do not define a valid
  /// downward-opening Gaussian log-parabola, centroid detection remains
  /// usable but no width claim is made.
  final double? psfFwhmPx;
}

class _BackgroundStatistics {
  const _BackgroundStatistics({required this.median, required this.sigma});

  final double median;
  final double sigma;
}

class _Candidate {
  _Candidate({required this.x, required this.y, required this.value});

  final int x;
  final int y;
  final double value;
}

class _ShapedCentroid {
  const _ShapedCentroid({
    required this.x,
    required this.y,
    required this.peakX,
    required this.peakY,
    required this.flux,
    required this.peakValue,
    required this.roundness,
    required this.sharpness,
    required this.coveredPixels,
  });

  final double x;
  final double y;
  // Preserve the detector's actual integer local-maximum coordinate.  The
  // intensity centroid can move by >0.5 px under asymmetric wings/noise; using
  // centroid.round() as the PSF-fit anchor can therefore select the wrong
  // 3-sample log-parabola.  The local maximum is the correct integer anchor
  // for the sub-pixel Gaussian refinement.
  final int peakX;
  final int peakY;
  final double flux;
  final double peakValue;
  final double roundness;
  final double sharpness;
  final int coveredPixels;
}

void _validateSource(LuminancePlane source) {
  if (source.width <= 0 ||
      source.height <= 0 ||
      source.samples.length != source.width * source.height) {
    throw InvalidStarDetectionInput(
      'Invalid star-detection source dimensions or sample count.',
    );
  }
  if (source.samples.any((double value) => !value.isFinite)) {
    throw InvalidStarDetectionInput(
      'Star-detection source must contain only finite luminance samples.',
    );
  }
}

/// Robust background level and noise estimate via median and median
/// absolute deviation (MAD), computed over a stride-subsampled set of
/// pixels for speed on large planes while remaining robust to the bright,
/// sparse pixels that stars themselves contribute.
_BackgroundStatistics _estimateBackgroundStatistics(
  LuminancePlane source,
  int sampleStride,
) {
  final int sampleWidth = (source.width + sampleStride - 1) ~/ sampleStride;
  final int sampleHeight = (source.height + sampleStride - 1) ~/ sampleStride;
  final Float64List values = Float64List(sampleWidth * sampleHeight);
  int destination = 0;
  for (int y = 0; y < source.height; y += sampleStride) {
    for (int x = 0; x < source.width; x += sampleStride) {
      values[destination++] = source.sampleAt(x, y);
    }
  }
  if (destination != values.length) {
    throw StateError('Star background sample geometry mismatch.');
  }
  values.sort();
  final double median = _percentile(values, 0.5);
  // Reuse the same packed Float64 allocation for MAD. This is numerically
  // identical to the old List<double> path, but avoids boxed-list overhead.
  for (int index = 0; index < values.length; index++) {
    values[index] = (values[index] - median).abs();
  }
  values.sort();
  // 1.4826 converts MAD to a standard-deviation-equivalent for normally
  // distributed noise, the conventional robust-statistics constant.
  final double sigma = 1.4826 * _percentile(values, 0.5);
  return _BackgroundStatistics(median: median, sigma: math.max(sigma, 1e-9));
}

double _percentile(List<double> sortedValues, double fraction) {
  if (sortedValues.isEmpty) return 0;
  final int index = math.min(
    sortedValues.length - 1,
    math.max(0, (fraction * (sortedValues.length - 1)).round()),
  );
  return sortedValues[index];
}

/// Finds local-maximum candidate pixels whose value exceeds
/// `background.median + thresholdSigma * background.sigma`, using a
/// `(2 * localMaxRadius + 1)`-square neighborhood test.
List<_Candidate> _findLocalMaximumCandidates({
  required LuminancePlane source,
  required _BackgroundStatistics background,
  required double thresholdSigma,
  required int localMaxRadius,
}) {
  final double threshold =
      background.median + thresholdSigma * background.sigma;
  final List<_Candidate> candidates = <_Candidate>[];
  for (int y = localMaxRadius; y < source.height - localMaxRadius; y++) {
    for (int x = localMaxRadius; x < source.width - localMaxRadius; x++) {
      final double value = source.sampleAt(x, y);
      if (value <= threshold) continue;
      bool isLocalMaximum = true;
      for (int dy = -localMaxRadius;
          dy <= localMaxRadius && isLocalMaximum;
          dy++) {
        for (int dx = -localMaxRadius; dx <= localMaxRadius; dx++) {
          if (dx == 0 && dy == 0) continue;
          if (source.sampleAt(x + dx, y + dy) > value) {
            isLocalMaximum = false;
            break;
          }
        }
      }
      if (isLocalMaximum) {
        candidates.add(_Candidate(x: x, y: y, value: value));
      }
    }
  }
  return candidates;
}

/// Computes an intensity-weighted sub-pixel centroid and shape diagnostics
/// within a square window around an integer-pixel peak.
_ShapedCentroid? _centroidWindow({
  required LuminancePlane source,
  required int peakX,
  required int peakY,
  required _BackgroundStatistics background,
  required int windowRadius,
  required double noiseFloorSigma,
}) {
  double weightedX = 0;
  double weightedY = 0;
  double totalWeight = 0;
  double peakValue = double.negativeInfinity;
  double innerWeight = 0;
  int coveredPixels = 0;
  final int left = math.max(0, peakX - windowRadius);
  final int right = math.min(source.width - 1, peakX + windowRadius);
  final int top = math.max(0, peakY - windowRadius);
  final int bottom = math.min(source.height - 1, peakY + windowRadius);
  // A pixel only contributes weight once it clears this floor above the
  // background median, not merely once it is nonzero. Without this,
  // ordinary background noise fluctuations elsewhere in the window (each
  // individually tiny, but numerous across a ~(2*windowRadius+1)^2-pixel
  // window) sum into a nonzero contribution to `totalWeight` and dilute
  // `innerWeight / totalWeight` (the sharpness metric): a real single-
  // pixel hot/warm pixel's flux is genuinely concentrated in one pixel,
  // but enough scattered sub-threshold noise elsewhere in the window can
  // still push its *measured* sharpness below `maxSharpness`, letting it
  // slip through as a false star detection. See WORK44_PROGRESS.md (Node
  // reference) for how this was found (empirically, not theoretically)
  // and measured.
  final double noiseFloor = noiseFloorSigma * background.sigma;

  for (int y = top; y <= bottom; y++) {
    for (int x = left; x <= right; x++) {
      final double raw = source.sampleAt(x, y);
      peakValue = math.max(peakValue, raw);
      final double weight = math.max(0, raw - background.median - noiseFloor);
      if (weight <= 0) continue;
      weightedX += weight * x;
      weightedY += weight * y;
      totalWeight += weight;
      coveredPixels += 1;
      if ((x - peakX).abs() <= 1 && (y - peakY).abs() <= 1) {
        innerWeight += weight;
      }
    }
  }
  if (totalWeight <= 0) return null;

  // Second moments about the centroid, used for the roundness estimate.
  final double centroidX = weightedX / totalWeight;
  final double centroidY = weightedY / totalWeight;
  double secondX = 0;
  double secondY = 0;
  double secondXY = 0;
  for (int y = top; y <= bottom; y++) {
    for (int x = left; x <= right; x++) {
      final double raw = source.sampleAt(x, y);
      final double weight = math.max(0, raw - background.median - noiseFloor);
      if (weight <= 0) continue;
      final double ox = x - centroidX;
      final double oy = y - centroidY;
      secondX += weight * ox * ox;
      secondY += weight * oy * oy;
      secondXY += weight * ox * oy;
    }
  }
  secondX /= totalWeight;
  secondY /= totalWeight;
  secondXY /= totalWeight;
  // Elongation from the eigenvalues of the 2x2 second-moment (covariance)
  // matrix [[secondX, secondXY], [secondXY, secondY]], not merely the
  // difference between the axis-aligned x and y moments: a source
  // elongated along a diagonal (e.g. a satellite trail crossing the frame
  // at 45 degrees) can have secondX == secondY while still being highly
  // elongated, with the anisotropy only visible in the secondXY
  // cross-term. Using the eigenvalues makes the roundness estimate
  // rotation-invariant.
  final double trace = secondX + secondY;
  final double discriminant = math.sqrt(
    math.max(
      0,
      math.pow((secondX - secondY) / 2, 2).toDouble() + secondXY * secondXY,
    ),
  );
  final double majorEigenvalue = trace / 2 + discriminant;
  final double minorEigenvalue = trace / 2 - discriminant;
  final double roundness =
      trace <= 1e-12 ? 0 : (majorEigenvalue - minorEigenvalue) / trace;
  final double sharpness = totalWeight <= 0 ? 1 : innerWeight / totalWeight;

  return _ShapedCentroid(
    x: centroidX,
    y: centroidY,
    peakX: peakX,
    peakY: peakY,
    flux: totalWeight,
    peakValue: peakValue,
    roundness: roundness,
    sharpness: sharpness,
    coveredPixels: coveredPixels,
  );
}

/// Detects point sources in [source] and returns them sorted by
/// descending flux.
///
/// - [thresholdSigma] (default 6): local-maximum acceptance threshold
///   above the robust background, in noise-sigma units.
/// - [localMaxRadius] (default 1): neighborhood radius for the initial
///   local-maximum test.
/// - [windowRadius] (default 4): centroiding/shape window radius; should
///   comfortably cover the expected PSF footprint.
/// - [minSeparation] (default `2 * windowRadius`): minimum pixel distance
///   enforced between accepted centroids during non-maximum suppression.
/// - [maxRoundness] (default 0.6): rejects candidates elongated beyond
///   this threshold (0 = round, 1 = a line), which screens out most
///   satellite/aircraft trails and read-noise streaks.
/// - [maxSharpness] (default 0.92): rejects candidates whose flux is
///   almost entirely inside the immediate 3x3 neighborhood, which
///   screens out isolated single-pixel hot/warm pixels.
/// - [minCoveredPixels] (default 2): rejects candidates with fewer than
///   this many above-background pixels in the window, another guard
///   against single-pixel defects.
/// - [noiseFloorSigma] (default 1.0): a pixel only contributes weight to
///   centroiding, flux, shape, and sharpness once it exceeds
///   `background.median + noiseFloorSigma * background.sigma`, not
///   merely once it is above the median. Without this floor, ordinary
///   background noise fluctuations scattered across the centroiding
///   window (individually tiny, but numerous) dilute the sharpness
///   metric enough that a genuinely single-pixel hot/warm pixel can
///   measure as less sharp than it really is and slip past
///   [maxSharpness] — an effect only visible with realistic background
///   noise present, not in a clean synthetic test (see WORK44_PROGRESS.md,
///   Node reference). Set to `0` to restore the original
///   any-positive-value-counts behavior.
/// - [maxStars] (default 200): caps the number of returned sources,
///   keeping only the brightest.
/// - [backgroundSampleStride] (default 4): subsampling stride used only
///   for the background statistics pass, not for detection itself.
List<DetectedStar> detectStars(
  LuminancePlane source, {
  double thresholdSigma = 6,
  int localMaxRadius = 1,
  int windowRadius = 4,
  int? minSeparation,
  double maxRoundness = 0.6,
  double maxSharpness = 0.92,
  int minCoveredPixels = 2,
  double noiseFloorSigma = 1.0,
  int maxStars = 200,
  int backgroundSampleStride = 4,
  bool usePsfRefinement = false,
}) {
  _validateSource(source);
  if (!thresholdSigma.isFinite ||
      thresholdSigma < 0 ||
      localMaxRadius < 0 ||
      windowRadius < 1 ||
      (minSeparation != null && minSeparation < 0) ||
      !maxRoundness.isFinite ||
      maxRoundness < 0 ||
      !maxSharpness.isFinite ||
      maxSharpness < 0 ||
      minCoveredPixels < 0 ||
      !noiseFloorSigma.isFinite ||
      noiseFloorSigma < 0 ||
      maxStars < 0 ||
      backgroundSampleStride < 1) {
    throw InvalidStarDetectionInput(
      'Star-detection parameters must be finite and within valid ranges.',
    );
  }
  final int effectiveMinSeparation = minSeparation ?? 2 * windowRadius;

  if (source.width <= 2 * windowRadius || source.height <= 2 * windowRadius) {
    return const <DetectedStar>[];
  }

  final _BackgroundStatistics background = _estimateBackgroundStatistics(
    source,
    math.max(1, backgroundSampleStride),
  );
  final List<_Candidate> candidates = _findLocalMaximumCandidates(
    source: source,
    background: background,
    thresholdSigma: thresholdSigma,
    localMaxRadius: localMaxRadius,
  );
  candidates.sort((_Candidate a, _Candidate b) => b.value.compareTo(a.value));

  final List<_ShapedCentroid> accepted = <_ShapedCentroid>[];
  final int minSeparationSquared =
      effectiveMinSeparation * effectiveMinSeparation;
  for (final _Candidate candidate in candidates) {
    if (accepted.length >= maxStars * 4) break; // bound worst-case cost
    bool tooClose = false;
    for (final _ShapedCentroid existing in accepted) {
      final double dx = existing.x - candidate.x;
      final double dy = existing.y - candidate.y;
      if (dx * dx + dy * dy < minSeparationSquared) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    final _ShapedCentroid? shaped = _centroidWindow(
      source: source,
      peakX: candidate.x,
      peakY: candidate.y,
      background: background,
      windowRadius: windowRadius,
      noiseFloorSigma: noiseFloorSigma,
    );
    if (shaped == null) continue;
    if (shaped.coveredPixels < minCoveredPixels) continue;
    if (shaped.roundness > maxRoundness) continue;
    if (shaped.sharpness > maxSharpness) continue;

    accepted.add(shaped);
  }

  accepted.sort(
    (_ShapedCentroid a, _ShapedCentroid b) => b.flux.compareTo(a.flux),
  );
  return accepted.take(maxStars).map(
    (_ShapedCentroid star) {
      // usePsfRefinement=trueの場合、既存の輝度重心(star.x/star.y)
      // を初期値として、分離可能ガウシアンの周辺分布への3点対数
      // 放物線フィット(Work117)でsub-pixel精度を精緻化する。
      // 精緻化できない場合(ウィンドウ端・対数未定義・非ピーク形状)
      // は既存の重心をそのまま使うため、悪化することはない。
      final RefinedCentroid? refined = usePsfRefinement
          ? refineCentroidWithGaussianPsfFit(
              source: source,
              peakX: star.peakX,
              peakY: star.peakY,
              initialX: star.x,
              initialY: star.y,
              backgroundMedian: background.median,
              windowRadius: windowRadius,
            )
          : null;
      double? psfFwhmPx;
      final double? sigmaX = refined?.sigmaX;
      final double? sigmaY = refined?.sigmaY;
      if (sigmaX != null && sigmaY != null) {
        final double equivalentSigma = math.sqrt(
          (sigmaX * sigmaX + sigmaY * sigmaY) / 2,
        );
        final double candidateFwhm = 2.354820045 * equivalentSigma;
        if (candidateFwhm.isFinite && candidateFwhm > 0) {
          psfFwhmPx = candidateFwhm;
        }
      }
      return DetectedStar(
        x: refined?.x ?? star.x,
        y: refined?.y ?? star.y,
        flux: star.flux,
        peakValue: star.peakValue,
        roundness: star.roundness,
        sharpness: star.sharpness,
        psfFwhmPx: psfFwhmPx,
      );
    },
  ).toList();
}
