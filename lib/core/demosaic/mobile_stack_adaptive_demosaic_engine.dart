import 'dart:math' as math;
import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/linear_rgb_tile.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'demosaic_algorithm.dart';
import 'demosaic_engine.dart';
import 'demosaic_request.dart';

/// Clean-room mathematical reference for Mobile Stack's adaptive demosaic.
///
/// This implementation is intentionally not marked production quality until
/// the equivalent native backend passes corpus, seam, performance, and device
/// validation. No third-party demosaic implementation source is used.
///
/// The reference keeps every dependency local to the source mosaic. Green is
/// recovered from four independently corrected cardinal candidates and four
/// quadrant candidates. A local green-luminance structure tensor classifies
/// coherent two-level edges separately from smooth ramps, periodic texture,
/// and point-like detail before blending with the conservative H/V estimate.
/// R-G and B-G interpolation adapts to that same directional confidence before
/// a gated 3x3 median suppresses false color while retaining star cores.
/// The complete dependency radius is five CFA pixels. The outer 3x3
/// color-difference suppression can query a neighboring color difference;
/// that estimate can in turn query a neighboring green estimate whose local
/// structure tensor reaches three CFA sites farther. The resulting worst-case
/// dependency is therefore 1 + 1 + 3 = 5 pixels from the output site. Keeping
/// this exact radius is also required by invalid/saturation influence masks.
final class MobileStackAdaptiveDemosaicEngine implements DemosaicEngine {
  const MobileStackAdaptiveDemosaicEngine();

  static const int referenceRequiredInputRadius = 5;

  @override
  int get requiredInputRadius => referenceRequiredInputRadius;
  static const double _starProtectionRange = 0.15;

  @override
  DemosaicAlgorithm get algorithm => DemosaicAlgorithm.mobileStackAdaptive;

  @override
  bool get isProductionQuality => false;

  @override
  Future<LinearRgbTile> processTile(DemosaicRequest request) async {
    request.validate();
    _validateInputCoverage(request);
    final LinearRawMosaic source = request.mosaic;
    for (int y = request.tile.inputY;
        y < request.tile.inputY + request.tile.inputHeight;
        y++) {
      final int row = y * source.width;
      for (int x = request.tile.inputX;
          x < request.tile.inputX + request.tile.inputWidth;
          x++) {
        if (!source.samples[row + x].isFinite) {
          throw ArgumentError(
            'Adaptive demosaic input contains a non-finite CFA sample.',
          );
        }
      }
    }
    final int width = request.tile.outputWidth;
    final int height = request.tile.outputHeight;
    final Float32List output = Float32List(width * height * 3);
    final _DemosaicCache cache = _DemosaicCache();

    for (int localY = 0; localY < height; localY++) {
      if (request.cancellationRequested) {
        throw const DemosaicProcessingCancelled();
      }
      final int y = request.tile.outputY + localY;
      for (int localX = 0; localX < width; localX++) {
        final int x = request.tile.outputX + localX;
        final CfaColor nativeColor = source.cfaPattern.colorAt(x, y);
        final double green = _greenAt(source, x, y, cache);
        final double red = nativeColor == CfaColor.red
            ? source.sampleAt(x, y)
            : green +
                _suppressedColorDifference(
                  source,
                  x,
                  y,
                  CfaColor.red,
                  cache,
                );
        final double blue = nativeColor == CfaColor.blue
            ? source.sampleAt(x, y)
            : green +
                _suppressedColorDifference(
                  source,
                  x,
                  y,
                  CfaColor.blue,
                  cache,
                );
        const double maximumFloat32 = 3.4028234663852886e38;
        if (!red.isFinite ||
            !green.isFinite ||
            !blue.isFinite ||
            red.abs() > maximumFloat32 ||
            green.abs() > maximumFloat32 ||
            blue.abs() > maximumFloat32) {
          throw StateError(
            'Adaptive demosaic produced a non-finite or Float32-overflow RGB sample.',
          );
        }
        final int base = (localY * width + localX) * 3;
        output[base] = red;
        output[base + 1] = green;
        output[base + 2] = blue;
      }
    }

    return LinearRgbTile(
      x: request.tile.outputX,
      y: request.tile.outputY,
      width: width,
      height: height,
      interleavedRgb: output,
    );
  }

  double _greenAt(LinearRawMosaic source, int x, int y, _DemosaicCache cache) {
    if (source.cfaPattern.colorAt(x, y) == CfaColor.green) {
      return source.sampleAt(x, y);
    }
    final int cacheKey = _cacheKey2(x, y);
    final double? cached = cache.green[cacheKey];
    if (cached != null) return cached;
    final double value = _computeGreenAt(source, x, y, cache);
    cache.green[cacheKey] = value;
    return value;
  }

  double _computeGreenAt(
    LinearRawMosaic source,
    int x,
    int y,
    _DemosaicCache cache,
  ) {
    final double center = source.sampleAt(x, y);
    const List<(int, int)> directions = <(int, int)>[
      (-1, 0),
      (1, 0),
      (0, -1),
      (0, 1),
    ];
    final List<double> estimates = <double>[];
    final List<double> residuals = <double>[];
    for (final (int dx, int dy) in directions) {
      final double adjacentGreen = _sample(source, x + dx, y + dy);
      final double sameColor = _sample(source, x + 2 * dx, y + 2 * dy);
      estimates.add(adjacentGreen + 0.5 * (center - sameColor));
      residuals.add(
        (center - sameColor).abs() +
            (_luminanceProxy(source, x, y, cache) -
                    _luminanceProxy(source, x + dx, y + dy, cache))
                .abs(),
      );
    }

    const List<(int, int)> quadrantPairs = <(int, int)>[
      (0, 2),
      (1, 2),
      (0, 3),
      (1, 3),
    ];
    final List<double> candidateValues = List<double>.of(estimates);
    final List<double> candidateResiduals = List<double>.of(residuals);
    for (final (int first, int second) in quadrantPairs) {
      candidateValues.add((estimates[first] + estimates[second]) * 0.5);
      candidateResiduals.add(
        (residuals[first] + residuals[second]) * 0.5,
      );
    }

    final _LocalStructure structure = _localStructure(source, x, y, cache);
    const double diagonalUnit = 0.7071067811865476;
    const List<(double, double)> directionVectors = <(double, double)>[
      (-1, 0),
      (1, 0),
      (0, -1),
      (0, 1),
      (-diagonalUnit, -diagonalUnit),
      (diagonalUnit, -diagonalUnit),
      (-diagonalUnit, diagonalUnit),
      (diagonalUnit, diagonalUnit),
    ];
    double weighted = 0;
    double totalWeight = 0;
    for (int index = 0; index < candidateValues.length; index++) {
      final (double dx, double dy) = directionVectors[index];
      final double directionalEnergy = math.max(
        0,
        dx * dx * structure.xx +
            2 * dx * dy * structure.xy +
            dy * dy * structure.yy,
      );
      final double cost = candidateResiduals[index] +
          directionalEnergy * (0.5 + 1.5 * structure.coherence);
      final double weight = 1 / (1e-8 + cost * cost);
      weighted += candidateValues[index] * weight;
      totalWeight += weight;
    }
    final double advanced = weighted / totalWeight;
    final double horizontal = (estimates[0] + estimates[1]) * 0.5;
    final double vertical = (estimates[2] + estimates[3]) * 0.5;
    final double horizontalGradient =
        (_sample(source, x - 1, y) - _sample(source, x + 1, y)).abs() +
            (2 * center - _sample(source, x - 2, y) - _sample(source, x + 2, y))
                .abs();
    final double verticalGradient =
        (_sample(source, x, y - 1) - _sample(source, x, y + 1)).abs() +
            (2 * center - _sample(source, x, y - 2) - _sample(source, x, y + 2))
                .abs();
    final double horizontalWeight =
        1 / (1e-6 + horizontalGradient * horizontalGradient);
    final double verticalWeight =
        1 / (1e-6 + verticalGradient * verticalGradient);
    final double conservative =
        (horizontal * horizontalWeight + vertical * verticalWeight) /
            (horizontalWeight + verticalWeight);
    final double blend = _smoothStep(0.72, 0.94, structure.coherence) *
        _smoothStep(0.18, 0.55, structure.directedCoherence) *
        _smoothStep(0.04, 0.1, math.sqrt(structure.energy)) *
        _smoothStep(0.32, 0.72, structure.bimodality);
    return conservative + (advanced - conservative) * blend;
  }

  double _luminanceProxy(
    LinearRawMosaic source,
    int x,
    int y,
    _DemosaicCache cache,
  ) {
    final int sampleX = _mirror(x, source.width);
    final int sampleY = _mirror(y, source.height);
    final int cacheKey = _cacheKey2(sampleX, sampleY);
    final double? cached = cache.proxy[cacheKey];
    if (cached != null) return cached;
    final double value = _computeLuminanceProxy(source, sampleX, sampleY);
    cache.proxy[cacheKey] = value;
    return value;
  }

  double _computeLuminanceProxy(
    LinearRawMosaic source,
    int sampleX,
    int sampleY,
  ) {
    if (source.cfaPattern.colorAt(sampleX, sampleY) == CfaColor.green) {
      return source.sampleAt(sampleX, sampleY);
    }
    return (_sample(source, sampleX - 1, sampleY) +
            _sample(source, sampleX + 1, sampleY) +
            _sample(source, sampleX, sampleY - 1) +
            _sample(source, sampleX, sampleY + 1)) *
        0.25;
  }

  _LocalStructure _localStructure(
    LinearRawMosaic source,
    int x,
    int y,
    _DemosaicCache cache,
  ) {
    final int cacheKey = _cacheKey2(x, y);
    final _LocalStructure? cached = cache.structure[cacheKey];
    if (cached != null) return cached;
    final _LocalStructure value = _computeLocalStructure(source, x, y, cache);
    cache.structure[cacheKey] = value;
    return value;
  }

  _LocalStructure _computeLocalStructure(
    LinearRawMosaic source,
    int x,
    int y,
    _DemosaicCache cache,
  ) {
    double xx = 0;
    double yy = 0;
    double xy = 0;
    double meanX = 0;
    double meanY = 0;
    double localMin = double.infinity;
    double localMax = double.negativeInfinity;
    final List<double> proxies = <double>[];
    for (int windowY = -1; windowY <= 1; windowY++) {
      for (int windowX = -1; windowX <= 1; windowX++) {
        final int sampleX = x + windowX;
        final int sampleY = y + windowY;
        final double proxy = _luminanceProxy(source, sampleX, sampleY, cache);
        proxies.add(proxy);
        if (proxy < localMin) localMin = proxy;
        if (proxy > localMax) localMax = proxy;
        final double gx = 0.5 *
            (_luminanceProxy(source, sampleX + 1, sampleY, cache) -
                _luminanceProxy(source, sampleX - 1, sampleY, cache));
        final double gy = 0.5 *
            (_luminanceProxy(source, sampleX, sampleY + 1, cache) -
                _luminanceProxy(source, sampleX, sampleY - 1, cache));
        xx += gx * gx;
        yy += gy * gy;
        xy += gx * gy;
        meanX += gx;
        meanY += gy;
      }
    }
    xx /= 9;
    yy /= 9;
    xy /= 9;
    meanX /= 9;
    meanY /= 9;
    final double trace = xx + yy;
    final double anisotropy = math.sqrt((xx - yy) * (xx - yy) + 4 * xy * xy);
    final double range = localMax - localMin;
    double twoLevelResidual = 0;
    if (range > 1e-12) {
      for (final double proxy in proxies) {
        twoLevelResidual += math.min(proxy - localMin, localMax - proxy);
      }
      twoLevelResidual /= proxies.length * range;
    }
    return _LocalStructure(
      xx: xx,
      yy: yy,
      xy: xy,
      energy: trace,
      coherence: anisotropy / (trace + 1e-12),
      directedCoherence: (meanX * meanX + meanY * meanY) / (trace + 1e-12),
      bimodality: range <= 1e-12 ? 0 : math.max(0, 1 - twoLevelResidual / 0.22),
    );
  }

  double _smoothStep(double lower, double upper, double value) {
    final double normalized =
        ((value - lower) / (upper - lower)).clamp(0, 1).toDouble();
    return normalized * normalized * (3 - 2 * normalized);
  }

  double _rawColorDifference(
    LinearRawMosaic source,
    int x,
    int y,
    CfaColor target,
    _DemosaicCache cache,
  ) {
    final int cacheKey = _cacheKey3(x, y, target);
    final double? cached = cache.colorDifference[cacheKey];
    if (cached != null) return cached;
    final double value =
        _computeRawColorDifference(source, x, y, target, cache);
    cache.colorDifference[cacheKey] = value;
    return value;
  }

  double _computeRawColorDifference(
    LinearRawMosaic source,
    int x,
    int y,
    CfaColor target,
    _DemosaicCache cache,
  ) {
    const List<(int, int)> cardinal = <(int, int)>[
      (-1, 0),
      (1, 0),
      (0, -1),
      (0, 1),
    ];
    const List<(int, int)> diagonal = <(int, int)>[
      (-1, -1),
      (1, -1),
      (-1, 1),
      (1, 1),
    ];
    final CfaColor nativeColor = source.cfaPattern.colorAt(x, y);
    if (nativeColor == target) {
      return source.sampleAt(x, y) - _greenAt(source, x, y, cache);
    }
    final List<(int, int)> offsets =
        nativeColor == CfaColor.green ? cardinal : diagonal;
    final Set<int> used = <int>{};
    double weightedDifference = 0;
    double totalWeight = 0;
    final double centerGreen = _greenAt(source, x, y, cache);
    final _LocalStructure structure = _localStructure(source, x, y, cache);
    final double rootEnergy = math.sqrt(structure.energy);
    final double edgeAdaptation = _smoothStep(0.7, 0.95, structure.coherence) *
        _smoothStep(0.025, 0.09, rootEnergy) *
        _smoothStep(0.18, 0.55, structure.directedCoherence) *
        _smoothStep(0.32, 0.72, structure.bimodality);
    final double textureAdaptation =
        (1 - structure.coherence) * _smoothStep(0.02, 0.08, rootEnergy);

    for (final (int dx, int dy) in offsets) {
      final int sampleX = _mirror(x + dx, source.width);
      final int sampleY = _mirror(y + dy, source.height);
      final int key = sampleY * source.width + sampleX;
      if (!used.add(key) ||
          source.cfaPattern.colorAt(sampleX, sampleY) != target ||
          source.isSaturatedAt(sampleX, sampleY)) {
        continue;
      }
      final double neighborGreen = _greenAt(source, sampleX, sampleY, cache);
      final double difference =
          source.sampleAt(sampleX, sampleY) - neighborGreen;
      final double length = math.sqrt((dx * dx + dy * dy).toDouble());
      final double unitX = dx / length;
      final double unitY = dy / length;
      final double directionalEnergy = math.max(
        0,
        unitX * unitX * structure.xx +
            2 * unitX * unitY * structure.xy +
            unitY * unitY * structure.yy,
      );
      final double cost = (centerGreen - neighborGreen).abs() +
          0.5 * edgeAdaptation * math.sqrt(directionalEnergy);
      final double exponent =
          1 + 0.45 * edgeAdaptation - 0.2 * textureAdaptation;
      final double weight = 1 / math.pow(1e-6 + cost, exponent).toDouble();
      weightedDifference += difference * weight;
      totalWeight += weight;
    }
    if (totalWeight == 0) return 0;
    return weightedDifference / totalWeight;
  }

  double _suppressedColorDifference(
    LinearRawMosaic source,
    int x,
    int y,
    CfaColor target,
    _DemosaicCache cache,
  ) {
    final List<double> neighborhood = <double>[];
    double localMin = double.infinity;
    double localMax = double.negativeInfinity;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        final int sampleX = _mirror(x + dx, source.width);
        final int sampleY = _mirror(y + dy, source.height);
        if (source.cfaPattern.colorAt(sampleX, sampleY) == target &&
            source.isSaturatedAt(sampleX, sampleY)) {
          continue;
        }
        final double value =
            _rawColorDifference(source, sampleX, sampleY, target, cache);
        neighborhood.add(value);
        if (value < localMin) localMin = value;
        if (value > localMax) localMax = value;
      }
    }
    final double center = _rawColorDifference(source, x, y, target, cache);
    if (neighborhood.isEmpty) return center;
    if (localMax - localMin > _starProtectionRange) return center;
    final List<double> sorted = List<double>.of(neighborhood)..sort();
    return sorted[sorted.length ~/ 2];
  }

  double _sample(LinearRawMosaic source, int x, int y) => source.sampleAt(
        _mirror(x, source.width),
        _mirror(y, source.height),
      );

  int _mirror(int coordinate, int length) {
    if (length <= 1) return 0;
    final int period = 2 * (length - 1);
    int value = coordinate % period;
    if (value < 0) value += period;
    return value < length ? value : period - value;
  }

  int _cacheKey2(int x, int y) => (x << 32) | (y & 0xFFFFFFFF);

  int _cacheKey3(int x, int y, CfaColor target) =>
      _cacheKey2(x, y) ^ ((target.index + 1) << 61);

  void _validateInputCoverage(DemosaicRequest request) {
    final OverlappedTile tile = request.tile;
    final int requiredLeft =
        (tile.outputX - requiredInputRadius).clamp(0, request.mosaic.width);
    final int requiredTop =
        (tile.outputY - requiredInputRadius).clamp(0, request.mosaic.height);
    final int requiredRight =
        (tile.outputX + tile.outputWidth + requiredInputRadius)
            .clamp(0, request.mosaic.width);
    final int requiredBottom =
        (tile.outputY + tile.outputHeight + requiredInputRadius)
            .clamp(0, request.mosaic.height);
    if (tile.inputX > requiredLeft ||
        tile.inputY > requiredTop ||
        tile.inputX + tile.inputWidth < requiredRight ||
        tile.inputY + tile.inputHeight < requiredBottom) {
      throw ArgumentError(
        'Mobile Stack adaptive demosaic requires a '
        '$requiredInputRadius-pixel CFA input radius.',
      );
    }
  }
}

/// Per-tile memoization cache for [MobileStackAdaptiveDemosaicEngine].
///
/// A fresh instance is created for each [MobileStackAdaptiveDemosaicEngine
/// .processTile] call and discarded when it returns, so it never persists
/// state across tiles, frames, or images, and every cached function remains
/// a pure function of its (source, x, y[, target]) inputs. The cache only
/// avoids recomputing a value that an earlier pixel in the same tile already
/// derived from identical inputs; it never changes an output value.
final class _DemosaicCache {
  final Map<int, double> proxy = <int, double>{};
  final Map<int, _LocalStructure> structure = <int, _LocalStructure>{};
  final Map<int, double> green = <int, double>{};
  final Map<int, double> colorDifference = <int, double>{};
}

final class _LocalStructure {
  const _LocalStructure({
    required this.xx,
    required this.yy,
    required this.xy,
    required this.energy,
    required this.coherence,
    required this.directedCoherence,
    required this.bimodality,
  });

  final double xx;
  final double yy;
  final double xy;
  final double energy;
  final double coherence;
  final double directedCoherence;
  final double bimodality;
}
