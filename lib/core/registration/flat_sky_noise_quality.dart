import 'dart:math' as math;

import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import 'star_detector.dart';

final class FlatSkyNoiseQualityComparison {
  const FlatSkyNoiseQualityComparison({
    required this.candidateTileCount,
    required this.selectedTileCount,
    required this.sampledCoefficientCount,
    this.referenceSupportedTileCount = 0,
    this.referenceCoefficientCount = 0,
    this.referenceSigma,
    this.finalSigma,
    this.noiseRatio,
  });

  final int candidateTileCount;
  final int selectedTileCount;
  final int sampledCoefficientCount;
  final int referenceSupportedTileCount;
  final int referenceCoefficientCount;
  final double? referenceSigma;
  final double? finalSigma;
  final double? noiseRatio;
}

final class FlatSkyNoiseQualityGateResult {
  const FlatSkyNoiseQualityGateResult({
    required this.comparison,
    required this.hasEnoughMeasurements,
    required this.passed,
    required this.reasons,
  });

  final FlatSkyNoiseQualityComparison comparison;
  final bool hasEnoughMeasurements;
  final bool passed;
  final List<String> reasons;
}

class MilkyWayNoiseQualityFailed implements Exception {
  const MilkyWayNoiseQualityFailed(this.result);

  final FlatSkyNoiseQualityGateResult result;

  @override
  String toString() =>
      'MilkyWayNoiseQualityFailed: ${result.reasons.join('; ')}';
}

final class _TileLocation {
  const _TileLocation(this.x, this.y, this.width, this.height);
  final int x;
  final int y;
  final int width;
  final int height;
}

final class _TileNoiseMeasure {
  const _TileNoiseMeasure({
    required this.location,
    required this.sigma,
    required this.coefficientCount,
  });
  final _TileLocation location;
  final double sigma;
  final int coefficientCount;
}

double _percentile(List<double> sorted, double fraction) {
  if (sorted.isEmpty) throw ArgumentError('percentile requires values.');
  if (sorted.length == 1) return sorted.first;
  final double position = fraction * (sorted.length - 1);
  final int lower = position.floor();
  final int upper = position.ceil();
  if (lower == upper) return sorted[lower];
  final double t = position - lower;
  return sorted[lower] * (1 - t) + sorted[upper] * t;
}

double _robustSigma(List<double> values) {
  if (values.length < 8) return double.nan;
  final List<double> sorted = List<double>.from(values)..sort();
  final double median = _percentile(sorted, 0.50);
  final List<double> deviations = <double>[
    for (final double value in values) (value - median).abs(),
  ]..sort();
  final double mad = _percentile(deviations, 0.50);
  return 1.4826 * mad;
}

bool _nearReferenceStar({
  required double x,
  required double y,
  required List<DetectedStar> stars,
}) {
  for (final DetectedStar star in stars) {
    final double fwhm = star.psfFwhmPx ?? 2.0;
    final double radius = math.max(4.0, fwhm * 2.0);
    final double dx = x - star.x;
    final double dy = y - star.y;
    if (dx * dx + dy * dy <= radius * radius) return true;
  }
  return false;
}

List<double> _checkerboardCoefficients({
  required LinearRgbTile tile,
  LinearRgbTile? pairedTile,
  required List<DetectedStar> referenceStars,
}) {
  final List<double> values = <double>[];
  for (int y = 0; y + 1 < tile.height; y += 2) {
    for (int x = 0; x + 1 < tile.width; x += 2) {
      final double globalX = tile.x + x + 0.5;
      final double globalY = tile.y + y + 0.5;
      if (_nearReferenceStar(
        x: globalX,
        y: globalY,
        stars: referenceStars,
      )) {
        continue;
      }
      if (pairedTile != null &&
          (!pairedTile.channelAt(x, y, 1).isFinite ||
              !pairedTile.channelAt(x + 1, y, 1).isFinite ||
              !pairedTile.channelAt(x, y + 1, 1).isFinite ||
              !pairedTile.channelAt(x + 1, y + 1, 1).isFinite)) {
        continue;
      }
      final double g00 = tile.channelAt(x, y, 1);
      final double g10 = tile.channelAt(x + 1, y, 1);
      final double g01 = tile.channelAt(x, y + 1, 1);
      final double g11 = tile.channelAt(x + 1, y + 1, 1);
      if (!g00.isFinite || !g10.isFinite || !g01.isFinite || !g11.isFinite) {
        continue;
      }
      // This 2x2 diagonal checkerboard has unit white-noise gain:
      // 4 coefficients of magnitude 0.5 -> sum(weights^2) == 1. A planar
      // luminance gradient cancels exactly, so the statistic is much less
      // sensitive to normal sky gradients than adjacent-pixel differences.
      values.add(0.5 * (g00 + g11 - g10 - g01));
    }
  }
  return values;
}

List<_TileLocation> _starAnchoredCandidateTiles({
  required int width,
  required int height,
  required List<DetectedStar> referenceStars,
  required int tileSize,
  required int maximumCandidates,
}) {
  final Set<int> seen = <int>{};
  final List<_TileLocation> locations = <_TileLocation>[];
  for (final DetectedStar star in referenceStars) {
    final int cellX =
        (star.x.floor() ~/ tileSize).clamp(0, (width - 1) ~/ tileSize).toInt();
    final int cellY =
        (star.y.floor() ~/ tileSize).clamp(0, (height - 1) ~/ tileSize).toInt();
    final int key = cellY * 100000 + cellX;
    if (!seen.add(key)) continue;
    final int x = cellX * tileSize;
    final int y = cellY * tileSize;
    final int w = math.min(tileSize, width - x).toInt();
    final int h = math.min(tileSize, height - y).toInt();
    if (w < 32 || h < 32) continue;
    locations.add(_TileLocation(x, y, w, h));
    if (locations.length >= maximumCandidates) break;
  }
  return locations;
}

/// Measures high-frequency random-noise scale in star-anchored, structurally
/// flat sky patches. Candidate coordinates are chosen from the reference and
/// reused unchanged for the final stack, so the comparison does not cherry-pick
/// a different region after stacking.
///
/// The measurement deliberately excludes small circles around reference stars
/// and uses the 2x2 checkerboard coefficient, which cancels planar gradients.
/// Candidate patches are ranked by the reference sigma and only the flattest
/// few are used. This is still a statistical quality metric, not semantic sky
/// segmentation; insufficient support returns an unverified result rather than
/// fabricating a verdict.
Future<FlatSkyNoiseQualityComparison> compareFlatSkyNoise({
  required LinearRgbTileStore referenceStore,
  required LinearRgbTileStore finalStore,
  required List<DetectedStar> referenceStars,
  int tileSize = 96,
  int maximumCandidateTiles = 24,
  int maximumSelectedTiles = 8,
}) async {
  if (referenceStore.width != finalStore.width ||
      referenceStore.height != finalStore.height) {
    throw ArgumentError('Reference/final dimensions must match.');
  }
  if (tileSize < 32 || maximumCandidateTiles < 1 || maximumSelectedTiles < 1) {
    throw ArgumentError('Invalid flat-sky noise measurement parameters.');
  }
  final List<_TileLocation> candidates = _starAnchoredCandidateTiles(
    width: referenceStore.width,
    height: referenceStore.height,
    referenceStars: referenceStars,
    tileSize: tileSize,
    maximumCandidates: maximumCandidateTiles,
  );
  final List<_TileNoiseMeasure> referenceMeasures = <_TileNoiseMeasure>[];
  for (final _TileLocation location in candidates) {
    final LinearRgbTile tile = await referenceStore.readRegion(
      x: location.x,
      y: location.y,
      width: location.width,
      height: location.height,
    );
    final List<double> coefficients = _checkerboardCoefficients(
      tile: tile,
      referenceStars: referenceStars,
    );
    final double sigma = _robustSigma(coefficients);
    if (!sigma.isFinite || sigma <= 0 || coefficients.length < 128) continue;
    referenceMeasures.add(_TileNoiseMeasure(
      location: location,
      sigma: sigma,
      coefficientCount: coefficients.length,
    ));
  }
  referenceMeasures.sort(
    (_TileNoiseMeasure a, _TileNoiseMeasure b) => a.sigma.compareTo(b.sigma),
  );
  final List<_TileNoiseMeasure> selected =
      referenceMeasures.take(maximumSelectedTiles).toList(growable: false);
  final int referenceSupport = selected.length;
  final int referenceSamples =
      selected.fold<int>(0, (sum, tile) => sum + tile.coefficientCount);
  if (selected.isEmpty) {
    return FlatSkyNoiseQualityComparison(
      candidateTileCount: candidates.length,
      referenceSupportedTileCount: referenceSupport,
      referenceCoefficientCount: referenceSamples,
      selectedTileCount: 0,
      sampledCoefficientCount: 0,
    );
  }

  final List<double> referenceTileSigmas = <double>[];
  final List<double> finalTileSigmas = <double>[];
  int coefficientCount = 0;
  for (final _TileNoiseMeasure referenceMeasure in selected) {
    final _TileLocation location = referenceMeasure.location;
    final LinearRgbTile finalTile = await finalStore.readRegion(
      x: location.x,
      y: location.y,
      width: location.width,
      height: location.height,
    );
    final LinearRgbTile referenceTile = await referenceStore.readRegion(
      x: location.x,
      y: location.y,
      width: location.width,
      height: location.height,
    );
    final List<double> pairedReferenceCoefficients = _checkerboardCoefficients(
      tile: referenceTile,
      pairedTile: finalTile,
      referenceStars: referenceStars,
    );
    final double pairedReferenceSigma =
        _robustSigma(pairedReferenceCoefficients);
    final List<double> finalCoefficients = _checkerboardCoefficients(
      tile: finalTile,
      pairedTile: referenceTile,
      referenceStars: referenceStars,
    );
    final double finalSigma = _robustSigma(finalCoefficients);
    if (!pairedReferenceSigma.isFinite ||
        pairedReferenceSigma <= 0 ||
        !finalSigma.isFinite ||
        finalSigma < 0 ||
        finalCoefficients.length < 128) {
      continue;
    }
    referenceTileSigmas.add(pairedReferenceSigma);
    finalTileSigmas.add(finalSigma);
    coefficientCount += math
        .min(
          pairedReferenceCoefficients.length,
          finalCoefficients.length,
        )
        .toInt();
  }
  if (referenceTileSigmas.isEmpty) {
    return FlatSkyNoiseQualityComparison(
      candidateTileCount: candidates.length,
      referenceSupportedTileCount: referenceSupport,
      referenceCoefficientCount: referenceSamples,
      selectedTileCount: 0,
      sampledCoefficientCount: 0,
    );
  }
  referenceTileSigmas.sort();
  finalTileSigmas.sort();
  final double referenceSigma = _percentile(referenceTileSigmas, 0.50);
  final double finalSigma = _percentile(finalTileSigmas, 0.50);
  return FlatSkyNoiseQualityComparison(
    candidateTileCount: candidates.length,
    referenceSupportedTileCount: referenceSupport,
    referenceCoefficientCount: referenceSamples,
    selectedTileCount: referenceTileSigmas.length,
    sampledCoefficientCount: coefficientCount,
    referenceSigma: referenceSigma,
    finalSigma: finalSigma,
    noiseRatio: referenceSigma > 0 ? finalSigma / referenceSigma : null,
  );
}

/// Fail-only noise gate. A correct aligned stack is expected to reduce random
/// sky noise; WORK348 nevertheless allows a 10% measurement margin before
/// blocking output. Blur cannot earn a false success on its own because the
/// separate WORK347 PSF gate must also pass.
FlatSkyNoiseQualityGateResult evaluateFlatSkyNoiseQualityGate({
  required FlatSkyNoiseQualityComparison comparison,
  int minimumSelectedTiles = 3,
  int minimumCoefficientSamples = 1024,
  double maximumNoiseRatio = 1.10,
}) {
  if (minimumSelectedTiles < 1 ||
      minimumCoefficientSamples < 1 ||
      !maximumNoiseRatio.isFinite ||
      maximumNoiseRatio <= 1) {
    throw ArgumentError('Invalid flat-sky noise gate parameters.');
  }
  final bool enough = comparison.selectedTileCount >= minimumSelectedTiles &&
      comparison.sampledCoefficientCount >= minimumCoefficientSamples;
  if (!enough) {
    final bool lostReferenceSupport =
        comparison.referenceSupportedTileCount >= minimumSelectedTiles &&
            comparison.referenceCoefficientCount >= minimumCoefficientSamples;
    return FlatSkyNoiseQualityGateResult(
      comparison: comparison,
      hasEnoughMeasurements: false,
      passed: !lostReferenceSupport,
      reasons: <String>[
        '${lostReferenceSupport ? "lost final support" : "insufficient reference support"}: '
            'selectedTiles=${comparison.selectedTileCount}/$minimumSelectedTiles, '
            'coefficients=${comparison.sampledCoefficientCount}/$minimumCoefficientSamples',
      ],
    );
  }
  final double? ratio = comparison.noiseRatio;
  final bool valid = ratio != null &&
      ratio.isFinite &&
      ratio >= 0 &&
      comparison.referenceSigma != null &&
      comparison.referenceSigma!.isFinite &&
      comparison.referenceSigma! > 0 &&
      comparison.finalSigma != null &&
      comparison.finalSigma!.isFinite &&
      comparison.finalSigma! >= 0;
  if (!valid) {
    return FlatSkyNoiseQualityGateResult(
      comparison: comparison,
      hasEnoughMeasurements: false,
      passed: false,
      reasons: const ['invalid flat-sky noise measurements'],
    );
  }
  final bool passed = ratio <= maximumNoiseRatio;
  return FlatSkyNoiseQualityGateResult(
    comparison: comparison,
    hasEnoughMeasurements: true,
    passed: passed,
    reasons: passed
        ? const <String>[]
        : <String>[
            'flat-sky noise ratio ${ratio.toStringAsFixed(4)} > ${maximumNoiseRatio.toStringAsFixed(4)}',
          ],
  );
}
