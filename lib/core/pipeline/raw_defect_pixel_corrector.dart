import 'dart:math' as math;

import '../image/linear_raw_mosaic.dart';
import 'raw_defect_map.dart';

class RawDefectCorrectionResult {
  const RawDefectCorrectionResult({
    required this.correctedCount,
    required this.skippedCount,
    required this.completed,
  });

  final int correctedCount;
  final int skippedCount;
  final bool completed;
}

/// 明示された欠陥画素だけを同一CFA位相の近傍から補間する。
class RawDefectPixelCorrector {
  const RawDefectPixelCorrector({
    this.maximumPointsPerChunk = 1024,
  }) : assert(maximumPointsPerChunk > 0);

  final int maximumPointsPerChunk;

  Future<RawDefectCorrectionResult> correct(
    LinearRawMosaic mosaic,
    RawDefectMap defectMap, {
    bool Function()? isCancelled,
    void Function(double progress)? reportProgress,
  }) async {
    final List<RawDefectPoint> points = defectMap.points;
    final Set<int> defectIndices = <int>{};
    for (final RawDefectPoint point in points) {
      if (point.x >= mosaic.width || point.y >= mosaic.height) {
        throw ArgumentError.value(
          defectMap,
          'defectMap',
          '欠陥画素座標がRAW画像範囲外です。',
        );
      }
      defectIndices.add(point.y * mosaic.width + point.x);
    }
    if (points.isEmpty) {
      reportProgress?.call(1);
      return const RawDefectCorrectionResult(
        correctedCount: 0,
        skippedCount: 0,
        completed: true,
      );
    }

    int correctedCount = 0;
    int skippedCount = 0;
    int chunkStart = 0;
    while (chunkStart < points.length) {
      if (isCancelled?.call() ?? false) {
        return RawDefectCorrectionResult(
          correctedCount: correctedCount,
          skippedCount: skippedCount,
          completed: false,
        );
      }
      final int chunkEnd = math.min(
        chunkStart + maximumPointsPerChunk,
        points.length,
      );
      for (int pointIndex = chunkStart; pointIndex < chunkEnd; pointIndex++) {
        final RawDefectPoint point = points[pointIndex];
        final int sampleIndex = point.y * mosaic.width + point.x;
        if (!mosaic.samples[sampleIndex].isFinite) {
          throw StateError('欠陥画素の元値が非有限です。');
        }
        final double? replacement = _replacementFor(
          mosaic,
          point,
          defectIndices,
        );
        if (replacement == null) {
          skippedCount++;
        } else {
          mosaic.samples[sampleIndex] = replacement;
          correctedCount++;
        }
      }
      chunkStart = chunkEnd;
      reportProgress?.call(chunkStart / points.length);
      if (chunkStart < points.length) {
        await Future<void>.delayed(Duration.zero);
      }
    }
    return RawDefectCorrectionResult(
      correctedCount: correctedCount,
      skippedCount: skippedCount,
      completed: true,
    );
  }

  double? _replacementFor(
    LinearRawMosaic mosaic,
    RawDefectPoint point,
    Set<int> defectIndices,
  ) {
    const List<List<int>> directions = <List<int>>[
      <int>[-2, 0, 2, 0],
      <int>[0, -2, 0, 2],
      <int>[-2, -2, 2, 2],
      <int>[2, -2, -2, 2],
    ];
    double? bestEstimate;
    double? bestDifference;
    for (final List<int> direction in directions) {
      final double? first = _neighbor(
        mosaic,
        point.x + direction[0],
        point.y + direction[1],
        defectIndices,
      );
      final double? second = _neighbor(
        mosaic,
        point.x + direction[2],
        point.y + direction[3],
        defectIndices,
      );
      if (first == null || second == null) continue;
      final double difference = (first - second).abs();
      final double estimate = (first + second) * 0.5;
      if (!estimate.isFinite) {
        throw StateError('欠陥画素の補間結果が非有限です。');
      }
      if (bestDifference == null || difference < bestDifference) {
        bestDifference = difference;
        bestEstimate = estimate;
      }
    }
    if (bestEstimate != null) return bestEstimate;

    final List<double> fallback = <double>[];
    for (final int offsetY in const <int>[-2, 0, 2]) {
      for (final int offsetX in const <int>[-2, 0, 2]) {
        if (offsetX == 0 && offsetY == 0) continue;
        final double? value = _neighbor(
          mosaic,
          point.x + offsetX,
          point.y + offsetY,
          defectIndices,
        );
        if (value != null) fallback.add(value);
      }
    }
    if (fallback.isEmpty) return null;
    fallback.sort();
    final int middle = fallback.length ~/ 2;
    if (fallback.length.isOdd) return fallback[middle];
    final double estimate = (fallback[middle - 1] + fallback[middle]) * 0.5;
    if (!estimate.isFinite) {
      throw StateError('欠陥画素の補間結果が非有限です。');
    }
    return estimate;
  }

  double? _neighbor(
    LinearRawMosaic mosaic,
    int x,
    int y,
    Set<int> defectIndices,
  ) {
    if (x < 0 || y < 0 || x >= mosaic.width || y >= mosaic.height) {
      return null;
    }
    final int index = y * mosaic.width + x;
    if (defectIndices.contains(index)) return null;
    if (mosaic.isSaturatedAt(x, y)) return null;
    final double value = mosaic.samples[index];
    if (!value.isFinite) {
      throw StateError('欠陥画素近傍に非有限値があります。');
    }
    return value;
  }
}
