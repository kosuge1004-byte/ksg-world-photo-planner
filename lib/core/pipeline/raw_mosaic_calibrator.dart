import 'dart:math' as math;

import '../image/linear_raw_mosaic.dart';

/// RAW CFAを追加のフルフレームバッファなしで線形補正する。
///
/// 黒レベルはActiveArea原点の2×2反復順、カメラWBは画像左上原点の
/// CFA順で受け取る。DNG 1.7.1 の線形化モデルに従い、黒引き後の
/// 負値は初期段階で保持する一方、WhiteLevel 正規化後の正側飽和値は
/// 1.0 にクリップする。
class RawMosaicCalibrator {
  const RawMosaicCalibrator({
    this.maximumSamplesPerChunk = 262144,
  }) : assert(maximumSamplesPerChunk > 0);

  final int maximumSamplesPerChunk;

  Future<bool> applyLinearizationTable(
    LinearRawMosaic mosaic, {
    required List<double> table,
    bool Function()? isCancelled,
    void Function(double progress)? reportProgress,
  }) async {
    if (table.isEmpty ||
        table.length > 65536 ||
        table.any((double value) =>
            !value.isFinite ||
            value < 0 ||
            value > 65535 ||
            value != value.roundToDouble())) {
      throw ArgumentError.value(
          table, 'table', 'Invalid DNG LinearizationTable.');
    }
    final int sampleCount = mosaic.samples.length;
    int start = 0;
    while (start < sampleCount) {
      if (isCancelled?.call() ?? false) return false;
      final int end = math.min(start + maximumSamplesPerChunk, sampleCount);
      for (int index = start; index < end; index++) {
        final double sample = mosaic.samples[index];
        if (!sample.isFinite || sample < 0) {
          throw StateError(
              'RAW stored sample is invalid before linearization.');
        }
        final int stored = sample.round();
        if ((sample - stored).abs() > 1e-6) {
          throw StateError(
              'RAW stored sample is not an integer encoding value.');
        }
        final int tableIndex =
            stored < table.length ? stored : table.length - 1;
        mosaic.samples[index] = table[tableIndex];
      }
      start = end;
      reportProgress?.call(start / sampleCount);
      if (start < sampleCount) await Future<void>.delayed(Duration.zero);
    }
    return true;
  }

  Future<bool> subtractBlackLevels(
    LinearRawMosaic mosaic, {
    required List<double> blackLevels,
    int patternOriginX = 0,
    int patternOriginY = 0,
    List<double>? blackLevelDeltaH,
    List<double>? blackLevelDeltaV,
    bool Function()? isCancelled,
    void Function(double progress)? reportProgress,
  }) {
    _validateBlackLevels(blackLevels);
    _validateBlackLevelDeltas(mosaic, blackLevelDeltaH, blackLevelDeltaV);
    return _transformInPlace(
      mosaic,
      offsets: blackLevels,
      scales: const <double>[1, 1, 1, 1],
      patternOriginX: patternOriginX,
      patternOriginY: patternOriginY,
      horizontalOffsets: blackLevelDeltaH,
      verticalOffsets: blackLevelDeltaV,
      isCancelled: isCancelled,
      reportProgress: reportProgress,
    );
  }

  Future<bool> normalizeWhiteLevel(
    LinearRawMosaic mosaic, {
    required List<double> blackLevels,
    required double whiteLevel,
    List<double>? blackLevelDeltaH,
    List<double>? blackLevelDeltaV,
    int patternOriginX = 0,
    int patternOriginY = 0,
    bool Function()? isCancelled,
    void Function(double progress)? reportProgress,
  }) {
    _validateBlackLevels(blackLevels);
    _validateBlackLevelDeltas(mosaic, blackLevelDeltaH, blackLevelDeltaV);
    if (!whiteLevel.isFinite || whiteLevel <= 0) {
      throw ArgumentError.value(
        whiteLevel,
        'whiteLevel',
        '有限の正数が必要です。',
      );
    }
    if (blackLevels.any((double value) => value >= whiteLevel)) {
      throw ArgumentError.value(
        blackLevels,
        'blackLevels',
        '全要素がwhiteLevel未満である必要があります。',
      );
    }
    final double maximumComputedBlackLevel = _maximumComputedBlackLevel(
      mosaic,
      blackLevels: blackLevels,
      horizontal: blackLevelDeltaH,
      vertical: blackLevelDeltaV,
      patternOriginX: patternOriginX,
      patternOriginY: patternOriginY,
    );
    if (maximumComputedBlackLevel >= whiteLevel) {
      throw ArgumentError.value(
        maximumComputedBlackLevel,
        'maximumComputedBlackLevel',
        'must remain below whiteLevel after BlackLevelDeltaH/V',
      );
    }
    return _transformInPlace(
      mosaic,
      offsets: const <double>[0, 0, 0, 0],
      // DNG 1.7.1: normalization uses the inverse of
      // (WhiteLevel - maximum computed black level for the sample plane),
      // not a separate denominator for each repeated 2x2 black-level phase.
      scales: List<double>.filled(
        4,
        1 / (whiteLevel - maximumComputedBlackLevel),
        growable: false,
      ),
      patternOriginX: 0,
      patternOriginY: 0,
      isCancelled: isCancelled,
      reportProgress: reportProgress,
      upperClamp: 1.0,
    );
  }

  Future<bool> applyCameraWhiteBalance(
    LinearRawMosaic mosaic, {
    required List<double> gains,
    bool Function()? isCancelled,
    void Function(double progress)? reportProgress,
  }) {
    if (gains.length != 4 ||
        gains.any((double value) => !value.isFinite || value <= 0)) {
      throw ArgumentError.value(
        gains,
        'gains',
        '4つの有限な正数が必要です。',
      );
    }
    return _transformInPlace(
      mosaic,
      offsets: const <double>[0, 0, 0, 0],
      scales: gains,
      patternOriginX: 0,
      patternOriginY: 0,
      isCancelled: isCancelled,
      reportProgress: reportProgress,
    );
  }

  Future<bool> _transformInPlace(
    LinearRawMosaic mosaic, {
    required List<double> offsets,
    required List<double> scales,
    required int patternOriginX,
    required int patternOriginY,
    List<double>? horizontalOffsets,
    List<double>? verticalOffsets,
    bool Function()? isCancelled,
    void Function(double progress)? reportProgress,
    double? upperClamp,
  }) async {
    const double maximumFiniteFloat32 = 3.4028234663852886e38;
    final int sampleCount = mosaic.samples.length;
    int chunkStart = 0;
    while (chunkStart < sampleCount) {
      if (isCancelled?.call() ?? false) return false;
      final int chunkEnd = math.min(
        chunkStart + maximumSamplesPerChunk,
        sampleCount,
      );
      int index = chunkStart;
      while (index < chunkEnd) {
        final int y = index ~/ mosaic.width;
        int x = index - y * mosaic.width;
        final int rowEnd = math.min(
          chunkEnd,
          (y + 1) * mosaic.width,
        );
        final int phaseRow = ((y - patternOriginY) & 1) << 1;
        while (index < rowEnd) {
          final int phase = phaseRow | ((x - patternOriginX) & 1);
          final double sample = mosaic.samples[index];
          if (!sample.isFinite) {
            throw StateError('RAW画素バッファに非有限値が含まれています。');
          }
          final double spatialOffset =
              (horizontalOffsets == null ? 0.0 : horizontalOffsets[x]) +
                  (verticalOffsets == null ? 0.0 : verticalOffsets[y]);
          final double transformed =
              (sample - offsets[phase] - spatialOffset) * scales[phase];
          if (!transformed.isFinite ||
              transformed.abs() > maximumFiniteFloat32) {
            throw StateError('RAW補正結果がFP32の有限範囲を超えました。');
          }
          mosaic.samples[index] = upperClamp != null && transformed > upperClamp
              ? upperClamp
              : transformed;
          index++;
          x++;
        }
      }
      chunkStart = chunkEnd;
      reportProgress?.call(chunkStart / sampleCount);
      if (chunkStart < sampleCount) {
        await Future<void>.delayed(Duration.zero);
      }
    }
    return true;
  }

  double _maximumComputedBlackLevel(
    LinearRawMosaic mosaic, {
    required List<double> blackLevels,
    required List<double>? horizontal,
    required List<double>? vertical,
    required int patternOriginX,
    required int patternOriginY,
  }) {
    // BlackLevelDeltaH/V are separable by column/row.  For a 2x2 CFA, the
    // exact maximum can therefore be computed from the maximum delta for each
    // x/y parity rather than scanning every pixel.  This keeps the result
    // identical while reducing large-frame work from O(width*height) to
    // O(width+height).
    final List<double> maximumHorizontal = _maximumDeltaByParity(
      length: mosaic.width,
      values: horizontal,
      patternOrigin: patternOriginX,
    );
    final List<double> maximumVertical = _maximumDeltaByParity(
      length: mosaic.height,
      values: vertical,
      patternOrigin: patternOriginY,
    );

    double maximum = double.negativeInfinity;
    for (int yPhase = 0; yPhase < 2; yPhase++) {
      for (int xPhase = 0; xPhase < 2; xPhase++) {
        final int phase = (yPhase << 1) | xPhase;
        if (!maximumHorizontal[xPhase].isFinite ||
            !maximumVertical[yPhase].isFinite) {
          continue;
        }
        final double value = blackLevels[phase] +
            maximumHorizontal[xPhase] +
            maximumVertical[yPhase];
        if (!value.isFinite) {
          throw StateError('Computed DNG black level is not finite.');
        }
        if (value > maximum) maximum = value;
      }
    }
    if (!maximum.isFinite) {
      throw StateError('Computed DNG black level is invalid.');
    }
    return maximum;
  }

  List<double> _maximumDeltaByParity({
    required int length,
    required List<double>? values,
    required int patternOrigin,
  }) {
    final List<double> maxima = <double>[
      double.negativeInfinity,
      double.negativeInfinity,
    ];
    for (int coordinate = 0; coordinate < length; coordinate++) {
      final int phase = (coordinate - patternOrigin) & 1;
      final double value = values == null ? 0.0 : values[coordinate];
      if (!value.isFinite) {
        throw StateError('DNG black-level delta is not finite.');
      }
      if (value > maxima[phase]) maxima[phase] = value;
    }
    // A one-pixel dimension can contain only one parity.  Leave the absent
    // parity as -infinity so callers can skip combinations that cannot occur.
    return maxima;
  }

  void _validateBlackLevelDeltas(
    LinearRawMosaic mosaic,
    List<double>? horizontal,
    List<double>? vertical,
  ) {
    if (horizontal != null &&
        (horizontal.length != mosaic.width ||
            horizontal.any((double value) => !value.isFinite))) {
      throw ArgumentError.value(
        horizontal,
        'blackLevelDeltaH',
        'must match mosaic width and contain finite values',
      );
    }
    if (vertical != null &&
        (vertical.length != mosaic.height ||
            vertical.any((double value) => !value.isFinite))) {
      throw ArgumentError.value(
        vertical,
        'blackLevelDeltaV',
        'must match mosaic height and contain finite values',
      );
    }
  }

  void _validateBlackLevels(List<double> blackLevels) {
    if (blackLevels.length != 4 ||
        blackLevels.any(
          (double value) => !value.isFinite || value < 0,
        )) {
      throw ArgumentError.value(
        blackLevels,
        'blackLevels',
        '4つの有限な非負数が必要です。',
      );
    }
  }
}
