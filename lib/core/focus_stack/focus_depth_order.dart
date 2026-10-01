import 'dart:typed_data';

import 'focus_measure.dart';
import 'focus_winner_map.dart';

FocusWinnerMap enforceLocalFocusOrderConsistency(
  FocusWinnerMap winners,
  List<FocusMeasurePlane> measures, {
  double confidenceThreshold = 0.25,
  double adjacentScoreRatio = 0.98,
}) {
  if (measures.length < 2 ||
      !confidenceThreshold.isFinite ||
      confidenceThreshold < 0 ||
      confidenceThreshold > 1 ||
      !adjacentScoreRatio.isFinite ||
      adjacentScoreRatio <= 0 ||
      adjacentScoreRatio > 1) {
    throw ArgumentError('Invalid focus-order consistency input.');
  }
  for (final FocusMeasurePlane measure in measures) {
    if (measure.width != winners.width || measure.height != winners.height) {
      throw ArgumentError('Focus-order measures must match winner dimensions.');
    }
  }

  final Int32List labels = Int32List.fromList(winners.frameIndices);
  final Float32List confidence = Float32List.fromList(winners.confidence);

  for (int index = 0; index < labels.length; index++) {
    if (confidence[index] >= confidenceThreshold) continue;
    final int current = labels[index];
    if (current < 0 || current >= measures.length) {
      throw ArgumentError('Winner frame index is outside focus-measure range.');
    }

    final double currentScore = measures[current].scores[index];
    int bestAdjacent = current;
    double bestAdjacentScore = currentScore;

    for (final int candidate in <int>[current - 1, current + 1]) {
      if (candidate < 0 || candidate >= measures.length) continue;
      final double score = measures[candidate].scores[index];
      if (score > bestAdjacentScore) {
        bestAdjacentScore = score;
        bestAdjacent = candidate;
      }
    }

    if (bestAdjacent != current &&
        currentScore <= bestAdjacentScore * adjacentScoreRatio) {
      labels[index] = bestAdjacent;
    }
  }

  return FocusWinnerMap(
    width: winners.width,
    height: winners.height,
    frameIndices: labels,
    confidence: confidence,
  );
}
