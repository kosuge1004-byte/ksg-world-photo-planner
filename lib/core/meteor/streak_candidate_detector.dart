import 'dart:math' as math;
import 'dart:typed_data';

import 'streak_shape.dart';

/// Dart port of `tool/raw_samples/streak_candidate_detector_reference.
/// mjs`.
///
/// Unlike `star_detector.dart`, which actively rejects elongated sources
/// to keep only point-like stars, this module looks specifically for
/// them: connected regions of above-background brightness that are long
/// and thin, the shape a meteor, a satellite pass, or an aircraft leaves
/// across a single exposure.
///
/// This module deliberately does not attempt to classify a candidate as
/// "meteor" versus "satellite" versus "aircraft" versus "sensor
/// artifact" — reliably telling these apart from pixel data alone in a
/// single frame is not robust, and Mobile Stack's meteor mode is
/// explicitly designed around a human reviewing and selecting which
/// detected candidate(s) to keep. This module's job is only to surface
/// every plausible candidate for that review step, not to make the
/// final call.
///
/// Algorithm: robust background/threshold estimation (shared approach
/// with the star detector), connected-component labeling of
/// above-threshold pixels (flood fill, 8-connectivity), then a
/// whole-region second-moment shape analysis to estimate each region's
/// orientation, length, and width, filtering for genuinely elongated,
/// sufficiently long regions, and finally a width-uniformity ("necking")
/// check plus a width-profile "multi-lobe" check, both guarding against
/// two or more nearby point sources accidentally merging into one
/// falsely-elongated region — see WORK43_PROGRESS.md and
/// WORK46_PROGRESS.md for how each was found and their documented
/// residual limitations.
///
/// This is the last, highest-risk meteor-mode module to be ported to
/// Dart (see WORK48/50/51's risk-ordering): its own Node development
/// needed several rounds of real bug-fixing (the eigenvector-angle
/// numerical-instability fix, the necking gate's discovery, the multi-
/// lobe gate's diagonal-streak-oscillation bug and its threshold-based-
/// runs redesign) that only actual test execution caught. This port was
/// therefore written with unusual care — every formula cross-checked
/// line by line against the current, already-hardened Node source
/// (rather than against any earlier, buggy intermediate version) — but
/// still has not been executed against the Dart SDK (unavailable in the
/// environment that wrote it). Run `test/streak_candidate_detector_
/// test.dart` (mirroring the Node fixtures, including every regression
/// test for the bugs described above) before relying on this in
/// production.

class InvalidStreakDetectionInput extends ArgumentError {
  InvalidStreakDetectionInput(super.message);
}

/// A single-channel intensity plane, matching `LuminancePlane`'s shape.
/// A lightweight local alias so this module doesn't depend on the
/// registration feature's type for what is otherwise an unrelated
/// concern — matching `streak_brightness_profile.dart`'s identical
/// design choice and its own doc comment for why.
abstract interface class StreakDetectionSource {
  int get width;
  int get height;
  List<double> get samples;
}

/// A detected streak-shaped candidate region.
///
/// [centroidX]/[centroidY]: intensity-weighted centroid of the region.
/// [angleRadians]: the streak's orientation (the major axis direction),
/// in `(-pi/2, pi/2]`; a streak is a line, not an arrow, so there is no
/// meaningful "start versus end" from shape alone.
/// [length]: the region's extent along its major axis, in pixels.
/// [width]: the same, along the minor axis — how thick the streak is.
/// [elongation]: `(majorEigenvalue - minorEigenvalue) / (majorEigenvalue
/// + minorEigenvalue)`, the same rotation-invariant metric the star
/// detector's roundness gate uses; a value near 1 means "very elongated"
/// (this module keeps *high*-elongation regions, the opposite selection
/// direction from the star detector).
/// [flux]: background-subtracted intensity sum over the region.
/// [pixelCount]: number of above-threshold pixels in the region.
/// [endpoints]: two points approximating the streak's visible extent.
final class StreakCandidate implements StreakGeometry {
  const StreakCandidate({
    required this.centroidX,
    required this.centroidY,
    required this.angleRadians,
    required this.length,
    required this.width,
    required this.elongation,
    required this.flux,
    required this.pixelCount,
    required this.endpoints,
  });

  @override
  final double centroidX;
  @override
  final double centroidY;
  @override
  final double angleRadians;
  final double length;
  @override
  final double width;
  final double elongation;
  final double flux;
  final int pixelCount;
  @override
  final List<({double x, double y})> endpoints;
}

double _sampleAt(StreakDetectionSource source, int x, int y) =>
    source.samples[y * source.width + x];

void _validateSource(StreakDetectionSource source) {
  if (source.width <= 0 ||
      source.height <= 0 ||
      source.samples.length != source.width * source.height) {
    throw InvalidStreakDetectionInput(
      'Invalid streak-detection source dimensions or sample count.',
    );
  }
}

double _percentile(List<double> sortedValues, double fraction) {
  if (sortedValues.isEmpty) return 0;
  final int index = math.min(
    sortedValues.length - 1,
    math.max(0, (fraction * (sortedValues.length - 1)).round()),
  );
  return sortedValues[index];
}

final class _BackgroundStatistics {
  const _BackgroundStatistics({required this.median, required this.sigma});

  final double median;
  final double sigma;
}

/// Same robust median/MAD approach as `star_detector.dart`, duplicated
/// (not shared) deliberately — see the Node reference's identical note
/// for why: the two detectors' background-estimation needs are
/// currently identical, but coupling them via a shared implementation
/// would make it easy to accidentally change one detector's threshold
/// behavior while tuning the other.
_BackgroundStatistics _estimateBackgroundStatistics(
  StreakDetectionSource source,
  int sampleStride,
) {
  final int sampleWidth = (source.width + sampleStride - 1) ~/ sampleStride;
  final int sampleHeight = (source.height + sampleStride - 1) ~/ sampleStride;
  final Float64List values = Float64List(sampleWidth * sampleHeight);
  int destination = 0;
  for (int y = 0; y < source.height; y += sampleStride) {
    for (int x = 0; x < source.width; x += sampleStride) {
      values[destination++] = _sampleAt(source, x, y);
    }
  }
  if (destination != values.length) {
    throw StateError('Streak background sample geometry mismatch.');
  }
  values.sort();
  final double median = _percentile(values, 0.5);
  // The old path allocated a second full sampled List<double> for MAD.
  // Reuse the same typed buffer: exact values, exact sort, lower peak memory.
  for (int i = 0; i < values.length; i++) {
    values[i] = (values[i] - median).abs();
  }
  values.sort();
  final double sigma = 1.4826 * _percentile(values, 0.5);
  return _BackgroundStatistics(median: median, sigma: math.max(sigma, 1e-9));
}

const List<(int, int)> _neighborOffsets8 = <(int, int)>[
  (-1, -1),
  (0, -1),
  (1, -1),
  (-1, 0),
  (1, 0),
  (-1, 1),
  (0, 1),
  (1, 1),
];

/// Labels connected components of above-threshold pixels via iterative
/// (explicit-stack, not recursive) flood fill, 8-connectivity. Returns a
/// list of pixel-index lists, one per component. [maxRegionPixels]
/// bounds a single flood fill's cost.
List<List<int>> _labelConnectedComponents(
  StreakDetectionSource source,
  double threshold,
  int maxRegionPixels,
) {
  final int width = source.width;
  final int height = source.height;
  final int pixelCount = width * height;
  final Uint8List visitedBits = Uint8List((pixelCount + 7) >> 3);
  bool isVisited(int index) =>
      (visitedBits[index >> 3] & (1 << (index & 7))) != 0;
  void markVisited(int index) {
    visitedBits[index >> 3] |= 1 << (index & 7);
  }

  final List<List<int>> components = <List<int>>[];
  final List<int> stack = <int>[];

  for (int startIndex = 0; startIndex < pixelCount; startIndex++) {
    if (isVisited(startIndex) || source.samples[startIndex] <= threshold) {
      continue;
    }
    final List<int> pixels = <int>[];
    stack.clear();
    stack.add(startIndex);
    markVisited(startIndex);
    while (stack.isNotEmpty) {
      final int index = stack.removeLast();
      pixels.add(index);
      if (pixels.length >= maxRegionPixels) break;
      final int x = index % width;
      final int y = index ~/ width;
      for (final (int dx, int dy) in _neighborOffsets8) {
        final int nx = x + dx;
        final int ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        final int neighborIndex = ny * width + nx;
        if (isVisited(neighborIndex)) continue;
        if (source.samples[neighborIndex] <= threshold) continue;
        markVisited(neighborIndex);
        stack.add(neighborIndex);
      }
    }
    components.add(pixels);
  }
  return components;
}

double _clamp(double value, double lower, double upper) =>
    math.min(upper, math.max(lower, value));

/// Computes the whole-region intensity-weighted centroid, second-moment
/// shape (orientation, length, width, elongation), and clamped endpoints
/// for one connected component. Returns `null` if the region has no net
/// positive weight (should not happen for a region that already cleared
/// the detection threshold, but guarded defensively, matching the Node
/// reference).
StreakCandidate? _analyzeRegionShape(
  StreakDetectionSource source,
  List<int> pixelIndices,
  _BackgroundStatistics background,
) {
  final int width = source.width;
  double weightedX = 0;
  double weightedY = 0;
  double totalWeight = 0;
  double minX = double.infinity;
  double maxX = double.negativeInfinity;
  double minY = double.infinity;
  double maxY = double.negativeInfinity;

  for (final int index in pixelIndices) {
    final int x = index % width;
    final int y = index ~/ width;
    final double weight =
        math.max(0, source.samples[index] - background.median);
    weightedX += weight * x;
    weightedY += weight * y;
    totalWeight += weight;
    if (x < minX) minX = x.toDouble();
    if (x > maxX) maxX = x.toDouble();
    if (y < minY) minY = y.toDouble();
    if (y > maxY) maxY = y.toDouble();
  }
  if (totalWeight <= 0) return null;
  final double centroidX = weightedX / totalWeight;
  final double centroidY = weightedY / totalWeight;

  double secondX = 0;
  double secondY = 0;
  double secondXY = 0;
  for (final int index in pixelIndices) {
    final int x = index % width;
    final int y = index ~/ width;
    final double weight =
        math.max(0, source.samples[index] - background.median);
    final double ox = x - centroidX;
    final double oy = y - centroidY;
    secondX += weight * ox * ox;
    secondY += weight * oy * oy;
    secondXY += weight * ox * oy;
  }
  secondX /= totalWeight;
  secondY /= totalWeight;
  secondXY /= totalWeight;

  final double trace = secondX + secondY;
  final double discriminant = math.sqrt(
    math.max(
      0,
      math.pow((secondX - secondY) / 2, 2).toDouble() + secondXY * secondXY,
    ),
  );
  final double majorEigenvalue = trace / 2 + discriminant;
  final double minorEigenvalue = trace / 2 - discriminant;
  final double elongation =
      trace <= 1e-12 ? 0 : (majorEigenvalue - minorEigenvalue) / trace;

  // Orientation via the standard closed-form 2D covariance/inertia
  // tensor principal-axis angle formula: theta = 0.5 * atan2(2*secondXY,
  // secondX - secondY). Preferred over an eigenvector-derived angle
  // (e.g. atan2(majorEigenvalue - secondX, secondXY)) because that
  // approach subtracts two nearly-equal numbers whenever the region is
  // close to axis-aligned (secondXY near 0) — a common case for a
  // streak, not an edge case — becoming numerically unstable exactly
  // when it matters most. This formula only ever differences secondX
  // and secondY directly, so it stays well-conditioned there. See the
  // Node reference's identical note (and WORK36_PROGRESS.md's original
  // discovery of this instability in the star detector's own roundness
  // computation, which this module's design already learned from).
  final double angleRadians = 0.5 * math.atan2(2 * secondXY, secondX - secondY);

  final double length = 4 * math.sqrt(math.max(0, majorEigenvalue));
  final double regionWidth = 4 * math.sqrt(math.max(0, minorEigenvalue));

  final double cos = math.cos(angleRadians);
  final double sin = math.sin(angleRadians);
  final double half = length / 2;
  final List<({double x, double y})> endpoints = <({double x, double y})>[
    (
      x: _clamp(centroidX + cos * half, minX, maxX),
      y: _clamp(centroidY + sin * half, minY, maxY),
    ),
    (
      x: _clamp(centroidX - cos * half, minX, maxX),
      y: _clamp(centroidY - sin * half, minY, maxY),
    ),
  ];

  return StreakCandidate(
    centroidX: centroidX,
    centroidY: centroidY,
    angleRadians: angleRadians,
    length: length,
    width: regionWidth,
    elongation: elongation,
    flux: totalWeight,
    pixelCount: pixelIndices.length,
    endpoints: endpoints,
  );
}

final class _WidthProfilePoint {
  const _WidthProfilePoint({required this.axisFraction, required this.width});

  final double axisFraction;
  final double width;
}

/// Measures the region's perpendicular width at every integer position
/// along its major axis. See the Node reference's identical function for
/// the full rationale (one bin per integer axis position, not a fixed
/// coarser bin count, so a single-pixel-wide neck is never averaged away
/// — see WORK43_PROGRESS.md).
List<_WidthProfilePoint> _measureWidthProfile(
  StreakDetectionSource source,
  List<int> pixelIndices,
  double centroidX,
  double centroidY,
  double cosAxis,
  double sinAxis,
) {
  final int width = source.width;
  double minAxis = double.infinity;
  double maxAxis = double.negativeInfinity;
  final Float64List axisProjections = Float64List(pixelIndices.length);
  final Float64List perpProjections = Float64List(pixelIndices.length);
  for (int i = 0; i < pixelIndices.length; i++) {
    final int index = pixelIndices[i];
    final int x = index % width;
    final int y = index ~/ width;
    final double dx = x - centroidX;
    final double dy = y - centroidY;
    final double axis = dx * cosAxis + dy * sinAxis;
    final double perp = -dx * sinAxis + dy * cosAxis;
    axisProjections[i] = axis;
    perpProjections[i] = perp;
    if (axis < minAxis) minAxis = axis;
    if (axis > maxAxis) maxAxis = axis;
  }
  final double span = maxAxis - minAxis;
  if (span <= 1e-6) return const <_WidthProfilePoint>[];

  final int binCount = math.max(1, span.round() + 1);
  final Float64List binMinPerp = Float64List(binCount)
    ..fillRange(0, binCount, double.infinity);
  final Float64List binMaxPerp = Float64List(binCount)
    ..fillRange(0, binCount, double.negativeInfinity);
  final Uint8List binHasData = Uint8List(binCount);
  for (int i = 0; i < pixelIndices.length; i++) {
    int bin = (axisProjections[i] - minAxis).round();
    if (bin >= binCount) bin = binCount - 1;
    if (bin < 0) bin = 0;
    binHasData[bin] = 1;
    if (perpProjections[i] < binMinPerp[bin]) {
      binMinPerp[bin] = perpProjections[i];
    }
    if (perpProjections[i] > binMaxPerp[bin]) {
      binMaxPerp[bin] = perpProjections[i];
    }
  }

  final List<_WidthProfilePoint> profile = <_WidthProfilePoint>[];
  for (int bin = 0; bin < binCount; bin++) {
    if (binHasData[bin] == 0) continue;
    profile.add(
      _WidthProfilePoint(
        axisFraction: binCount > 1 ? bin / (binCount - 1) : 0,
        // +1: two pixels one apart (perpendicular projections differing
        // by exactly 1) are 2 pixels wide, not a zero-width line.
        width: binMaxPerp[bin] - binMinPerp[bin] + 1,
      ),
    );
  }
  return profile;
}

final class _Run {
  _Run({required this.startIndex, required this.endIndex});

  final int startIndex;
  int endIndex;
}

/// Finds contiguous runs of `true` in [flags] at least [minRunLength]
/// samples long, merging runs separated by a `false` gap shorter than
/// [minGapLength]. Deliberately duplicated from `streak_brightness_
/// profile.dart`'s identical private helper — see the Node reference's
/// equivalent note for why (independent per-detector tuning, not coupled
/// through a shared implementation).
List<_Run> _findRuns(List<bool> flags, int minRunLength, int minGapLength) {
  final List<_Run> rawRuns = <_Run>[];
  int runStart = -1;
  for (int index = 0; index < flags.length; index++) {
    if (flags[index]) {
      if (runStart < 0) runStart = index;
    } else if (runStart >= 0) {
      rawRuns.add(_Run(startIndex: runStart, endIndex: index - 1));
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    rawRuns.add(_Run(startIndex: runStart, endIndex: flags.length - 1));
  }

  final List<_Run> merged = <_Run>[];
  for (final _Run run in rawRuns) {
    final _Run? previous = merged.isEmpty ? null : merged.last;
    if (previous != null &&
        run.startIndex - previous.endIndex - 1 < minGapLength) {
      previous.endIndex = run.endIndex;
    } else {
      merged.add(_Run(startIndex: run.startIndex, endIndex: run.endIndex));
    }
  }

  return merged
      .where((_Run run) => run.endIndex - run.startIndex + 1 >= minRunLength)
      .toList();
}

/// Smooths a width profile with a 5-point (2 on each side) moving
/// average before lobe counting — see the Node reference's identical
/// function for the full rationale (a real, test-caught diagonal-axis
/// pixel-discretization oscillation, see WORK46_PROGRESS.md).
List<_WidthProfilePoint> _smoothWidthProfile(
  List<_WidthProfilePoint> widthProfile,
) {
  final int n = widthProfile.length;
  if (n < 3) return widthProfile;
  const int radius = 2;
  final List<_WidthProfilePoint> smoothed =
      List<_WidthProfilePoint>.filled(n, widthProfile[0]);
  for (int i = 0; i < n; i++) {
    double sum = 0;
    int count = 0;
    for (int offset = -radius; offset <= radius; offset++) {
      final int j = math.min(n - 1, math.max(0, i + offset));
      sum += widthProfile[j].width;
      count += 1;
    }
    smoothed[i] = _WidthProfilePoint(
      axisFraction: widthProfile[i].axisFraction,
      width: sum / count,
    );
  }
  return smoothed;
}

/// Counts the number of significant "lobes" (wide stretches) in a width
/// profile via threshold-based run detection — see the Node reference's
/// identical function for the full rationale, including why this
/// replaced an earlier topographic-prominence-based implementation (a
/// real bug found by this gate's own testing; see WORK46_PROGRESS.md).
int _countSignificantWidthLobes(
  List<_WidthProfilePoint> widthProfile,
  double lobeThresholdRatio,
  int minRunSamples,
  int minGapSamples,
) {
  final List<_WidthProfilePoint> smoothed = _smoothWidthProfile(widthProfile);
  if (smoothed.isEmpty) return 0;
  double maxWidth = 0;
  for (final _WidthProfilePoint point in smoothed) {
    if (point.width > maxWidth) maxWidth = point.width;
  }
  if (maxWidth <= 0) return 0;
  final double threshold = maxWidth * lobeThresholdRatio;
  final List<bool> wideFlags = smoothed
      .map((_WidthProfilePoint point) => point.width >= threshold)
      .toList();
  final List<_Run> runs = _findRuns(wideFlags, minRunSamples, minGapSamples);
  return math.max(runs.length, 1);
}

final class _NeckingResult {
  const _NeckingResult({
    required this.hasNecking,
    required this.minInteriorWidth,
    required this.maxWidth,
  });

  final bool hasNecking;
  final double minInteriorWidth;
  final double maxWidth;
}

/// Checks a region's width profile for a "necking" (dumbbell) artifact —
/// see the Node reference's identical function for the full rationale
/// (WORK43_PROGRESS.md), including why the interior exclusion at each
/// end tolerates a genuine meteor's legitimately tapering tail.
_NeckingResult _detectNeckingArtifact(
  List<_WidthProfilePoint> widthProfile,
  double minWidthUniformity,
  double endExclusionFraction,
) {
  if (widthProfile.isEmpty) {
    return const _NeckingResult(
      hasNecking: false,
      minInteriorWidth: 0,
      maxWidth: 0,
    );
  }
  double maxWidth = 0;
  for (final _WidthProfilePoint point in widthProfile) {
    if (point.width > maxWidth) maxWidth = point.width;
  }
  final List<_WidthProfilePoint> interior = widthProfile
      .where(
        (_WidthProfilePoint point) =>
            point.axisFraction >= endExclusionFraction &&
            point.axisFraction <= 1 - endExclusionFraction,
      )
      .toList();
  if (interior.isEmpty || maxWidth <= 0) {
    return _NeckingResult(
      hasNecking: false,
      minInteriorWidth: maxWidth,
      maxWidth: maxWidth,
    );
  }
  double minInteriorWidth = double.infinity;
  for (final _WidthProfilePoint point in interior) {
    if (point.width < minInteriorWidth) minInteriorWidth = point.width;
  }
  return _NeckingResult(
    hasNecking: minInteriorWidth / maxWidth < minWidthUniformity,
    minInteriorWidth: minInteriorWidth,
    maxWidth: maxWidth,
  );
}

/// Detects streak-shaped candidates in [source] and returns them sorted
/// by descending flux.
///
/// - [thresholdSigma] (default 5): above-background acceptance threshold
///   for a pixel to join a region, in noise-sigma units.
/// - [minLength] (default 15): rejects regions whose major-axis extent
///   falls below this many pixels — the primary filter distinguishing a
///   streak from a compact star-like blob.
/// - [minElongation] (default 0.8): rejects regions that aren't
///   sufficiently elongated (0 = round, approaching 1 = a line).
/// - [minPixelCount] (default 8): rejects regions with too few
///   above-threshold pixels to trust a shape estimate.
/// - [maxCandidates] (default 50): caps the number of returned regions,
///   keeping only the brightest.
/// - [maxRegionPixels] (default 20000): caps a single connected
///   component's flood-fill cost.
/// - [minWidthUniformity] (default 0.3): rejects a region whose
///   perpendicular width, at some point in its interior, drops below
///   this fraction of the region's widest point elsewhere — the
///   "dumbbell" signature of merged point sources. Set to `0` to disable.
/// - [neckingEndExclusionFraction] (default 0.15): the fraction of the
///   region's populated axis range, at each end, excluded from the
///   necking check.
/// - [maxWidthProfileLobes] (default 1): rejects a region whose width
///   profile has more than this many significant local maxima ("lobes").
///   Set to [double.infinity] to disable.
/// - [widthProfileLobeThresholdRatio] (default 0.7): a bin counts as
///   part of a "wide" lobe once its width reaches this fraction of the
///   profile's own widest point.
/// - [widthProfileLobeMinRunPixels] (default 3) /
///   [widthProfileLobeMinGapPixels] (default 3): minimum lobe length and
///   minimum gap length (in pixels along the axis) for lobe counting.
/// - [backgroundSampleStride] (default 4): subsampling stride used only
///   for the background statistics pass.
List<StreakCandidate> detectStreakCandidates(
  StreakDetectionSource source, {
  double thresholdSigma = 5,
  double minLength = 15,
  double minElongation = 0.8,
  int minPixelCount = 8,
  int maxCandidates = 50,
  int maxRegionPixels = 20000,
  double minWidthUniformity = 0.3,
  double neckingEndExclusionFraction = 0.15,
  double maxWidthProfileLobes = 1,
  double widthProfileLobeThresholdRatio = 0.7,
  int widthProfileLobeMinRunPixels = 3,
  int widthProfileLobeMinGapPixels = 3,
  int backgroundSampleStride = 4,
}) {
  _validateSource(source);

  final _BackgroundStatistics background = _estimateBackgroundStatistics(
    source,
    math.max(1, backgroundSampleStride),
  );
  final double threshold =
      background.median + thresholdSigma * background.sigma;
  final List<List<int>> components = _labelConnectedComponents(
    source,
    threshold,
    maxRegionPixels,
  );

  final List<StreakCandidate> candidates = <StreakCandidate>[];
  for (final List<int> pixels in components) {
    if (pixels.length < minPixelCount) continue;
    final StreakCandidate? shape = _analyzeRegionShape(
      source,
      pixels,
      background,
    );
    if (shape == null) continue;
    if (shape.length < minLength) continue;
    if (shape.elongation < minElongation) continue;

    if (minWidthUniformity > 0 || maxWidthProfileLobes.isFinite) {
      final double cosAxis = math.cos(shape.angleRadians);
      final double sinAxis = math.sin(shape.angleRadians);
      final List<_WidthProfilePoint> widthProfile = _measureWidthProfile(
        source,
        pixels,
        shape.centroidX,
        shape.centroidY,
        cosAxis,
        sinAxis,
      );
      if (minWidthUniformity > 0) {
        final _NeckingResult necking = _detectNeckingArtifact(
          widthProfile,
          minWidthUniformity,
          neckingEndExclusionFraction,
        );
        if (necking.hasNecking) continue;
      }
      if (maxWidthProfileLobes.isFinite) {
        final int lobeCount = _countSignificantWidthLobes(
          widthProfile,
          widthProfileLobeThresholdRatio,
          widthProfileLobeMinRunPixels,
          widthProfileLobeMinGapPixels,
        );
        if (lobeCount > maxWidthProfileLobes) continue;
      }
    }

    candidates.add(shape);
  }
  candidates.sort(
    (StreakCandidate a, StreakCandidate b) => b.flux.compareTo(a.flux),
  );
  return candidates.length > maxCandidates
      ? candidates.sublist(0, maxCandidates)
      : candidates;
}
