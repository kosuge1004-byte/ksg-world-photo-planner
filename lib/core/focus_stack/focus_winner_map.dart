import 'dart:typed_data';

import 'focus_measure.dart';

final class FocusWinnerMap {
  FocusWinnerMap({
    required this.width,
    required this.height,
    required Int32List frameIndices,
    required Float32List confidence,
  })  : frameIndices = frameIndices,
        confidence = confidence {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Focus winner-map dimensions must be positive.');
    }
    final int count = width * height;
    if (frameIndices.length != count || confidence.length != count) {
      throw ArgumentError('Focus winner-map buffers do not match dimensions.');
    }
    for (int index = 0; index < count; index++) {
      if (frameIndices[index] < 0) {
        throw ArgumentError('Winner frame indices must be non-negative.');
      }
      final double value = confidence[index];
      if (!value.isFinite || value < 0 || value > 1) {
        throw ArgumentError('Focus confidence must be finite in [0,1].');
      }
    }
  }

  final int width;
  final int height;
  final Int32List frameIndices;
  final Float32List confidence;
}

FocusWinnerMap selectFocusWinners(
  List<FocusMeasurePlane> measures, {
  double absoluteScoreFloor = 0,
}) {
  if (measures.length < 2) {
    throw ArgumentError('At least two focus-measure planes are required.');
  }
  if (!absoluteScoreFloor.isFinite || absoluteScoreFloor < 0) {
    throw ArgumentError.value(absoluteScoreFloor, 'absoluteScoreFloor');
  }

  final int width = measures.first.width;
  final int height = measures.first.height;
  for (final FocusMeasurePlane plane in measures) {
    if (plane.width != width || plane.height != height) {
      throw ArgumentError(
          'All focus-measure planes must have equal dimensions.');
    }
  }

  final int count = width * height;
  final Int32List winners = Int32List(count);
  final Float32List confidence = Float32List(count);

  for (int index = 0; index < count; index++) {
    int bestFrame = 0;
    double best = measures[0].scores[index];
    double second = -1;
    for (int frame = 1; frame < measures.length; frame++) {
      final double score = measures[frame].scores[index];
      if (score > best) {
        second = best;
        best = score;
        bestFrame = frame;
      } else if (score > second) {
        second = score;
      }
    }
    winners[index] = bestFrame;
    if (best <= absoluteScoreFloor || best <= 0) {
      confidence[index] = 0;
      continue;
    }
    if (second < 0) second = 0;
    confidence[index] = ((best - second) / best).clamp(0, 1).toDouble();
  }

  return FocusWinnerMap(
    width: width,
    height: height,
    frameIndices: winners,
    confidence: confidence,
  );
}
