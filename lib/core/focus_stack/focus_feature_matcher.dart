import 'dart:math' as math;

import '../registration/luminance_plane.dart';
import 'focus_alignment_estimator.dart';
import 'focus_feature_detector.dart';

final class FocusFeatureMatch {
  const FocusFeatureMatch({
    required this.reference,
    required this.source,
    required this.correlation,
  });

  final FocusFeaturePoint reference;
  final FocusFeaturePoint source;
  final double correlation;

  FocusAlignmentMatch toAlignmentMatch() => FocusAlignmentMatch(
        referenceX: reference.x,
        referenceY: reference.y,
        sourceX: source.x,
        sourceY: source.y,
      );
}

/// Matches detected focus features using zero-mean normalized cross-correlation
/// (ZNCC) over linear-luminance patches.
///
/// A match is kept only when it is the mutual best match and its best
/// correlation is separated from the second-best by [minimumSeparation].
/// This removes many repeated-texture ambiguities before the geometric MAD
/// rejection in [estimateFocusAlignment].
List<FocusFeatureMatch> matchFocusFeatures({
  required LuminancePlane referenceLuminance,
  required LuminancePlane sourceLuminance,
  required List<FocusFeaturePoint> referenceFeatures,
  required List<FocusFeaturePoint> sourceFeatures,
  int patchRadius = 4,
  double minimumCorrelation = 0.75,
  double minimumSeparation = 0.05,
}) {
  if (referenceLuminance.width != sourceLuminance.width ||
      referenceLuminance.height != sourceLuminance.height) {
    throw ArgumentError('Reference/source luminance dimensions must match.');
  }
  if (patchRadius < 1 || patchRadius > 32) {
    throw ArgumentError.value(patchRadius, 'patchRadius');
  }
  if (!minimumCorrelation.isFinite ||
      minimumCorrelation < -1 ||
      minimumCorrelation > 1 ||
      !minimumSeparation.isFinite ||
      minimumSeparation < 0 ||
      minimumSeparation > 2) {
    throw ArgumentError('Focus-feature match thresholds are invalid.');
  }

  final List<_BestMatch> forward = <_BestMatch>[
    for (int i = 0; i < referenceFeatures.length; i++)
      _bestMatchFor(
        query: referenceFeatures[i],
        candidates: sourceFeatures,
        queryImage: referenceLuminance,
        candidateImage: sourceLuminance,
        patchRadius: patchRadius,
      ),
  ];
  final List<_BestMatch> reverse = <_BestMatch>[
    for (int j = 0; j < sourceFeatures.length; j++)
      _bestMatchFor(
        query: sourceFeatures[j],
        candidates: referenceFeatures,
        queryImage: sourceLuminance,
        candidateImage: referenceLuminance,
        patchRadius: patchRadius,
      ),
  ];

  final List<FocusFeatureMatch> matches = <FocusFeatureMatch>[];
  for (int referenceIndex = 0;
      referenceIndex < referenceFeatures.length;
      referenceIndex++) {
    final _BestMatch f = forward[referenceIndex];
    if (f.bestIndex < 0 ||
        f.bestCorrelation < minimumCorrelation ||
        f.bestCorrelation - f.secondCorrelation < minimumSeparation) {
      continue;
    }
    final _BestMatch r = reverse[f.bestIndex];
    if (r.bestIndex != referenceIndex) continue;
    matches.add(
      FocusFeatureMatch(
        reference: referenceFeatures[referenceIndex],
        source: sourceFeatures[f.bestIndex],
        correlation: f.bestCorrelation,
      ),
    );
  }

  matches.sort(
    (FocusFeatureMatch a, FocusFeatureMatch b) =>
        b.correlation.compareTo(a.correlation),
  );
  return List<FocusFeatureMatch>.unmodifiable(matches);
}

final class _BestMatch {
  const _BestMatch({
    required this.bestIndex,
    required this.bestCorrelation,
    required this.secondCorrelation,
  });

  final int bestIndex;
  final double bestCorrelation;
  final double secondCorrelation;
}

_BestMatch _bestMatchFor({
  required FocusFeaturePoint query,
  required List<FocusFeaturePoint> candidates,
  required LuminancePlane queryImage,
  required LuminancePlane candidateImage,
  required int patchRadius,
}) {
  int bestIndex = -1;
  double best = -2;
  double second = -2;
  for (int index = 0; index < candidates.length; index++) {
    final double correlation = _zncc(
      queryImage,
      candidateImage,
      query.x.round(),
      query.y.round(),
      candidates[index].x.round(),
      candidates[index].y.round(),
      patchRadius,
    );
    if (!correlation.isFinite) continue;
    if (correlation > best) {
      second = best;
      best = correlation;
      bestIndex = index;
    } else if (correlation > second) {
      second = correlation;
    }
  }
  return _BestMatch(
    bestIndex: bestIndex,
    bestCorrelation: best,
    secondCorrelation: second,
  );
}

double _zncc(
  LuminancePlane a,
  LuminancePlane b,
  int ax,
  int ay,
  int bx,
  int by,
  int radius,
) {
  if (ax - radius < 0 ||
      ay - radius < 0 ||
      ax + radius >= a.width ||
      ay + radius >= a.height ||
      bx - radius < 0 ||
      by - radius < 0 ||
      bx + radius >= b.width ||
      by + radius >= b.height) {
    return double.nan;
  }

  final int diameter = radius * 2 + 1;
  final int count = diameter * diameter;
  double meanA = 0;
  double meanB = 0;
  for (int dy = -radius; dy <= radius; dy++) {
    for (int dx = -radius; dx <= radius; dx++) {
      meanA += a.samples[(ay + dy) * a.width + ax + dx];
      meanB += b.samples[(by + dy) * b.width + bx + dx];
    }
  }
  meanA /= count;
  meanB /= count;

  double numerator = 0;
  double energyA = 0;
  double energyB = 0;
  for (int dy = -radius; dy <= radius; dy++) {
    for (int dx = -radius; dx <= radius; dx++) {
      final double da = a.samples[(ay + dy) * a.width + ax + dx] - meanA;
      final double db = b.samples[(by + dy) * b.width + bx + dx] - meanB;
      numerator += da * db;
      energyA += da * da;
      energyB += db * db;
    }
  }
  if (!(energyA > 0) || !(energyB > 0)) return double.nan;
  return numerator / math.sqrt(energyA * energyB);
}
