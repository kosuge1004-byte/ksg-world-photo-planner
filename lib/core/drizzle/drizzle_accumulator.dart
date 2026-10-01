import 'dart:math' as math;
import 'dart:typed_data';

final class InvalidDrizzleInput extends ArgumentError {
  InvalidDrizzleInput(super.message);
}

final class DrizzleResult {
  const DrizzleResult({
    required this.width,
    required this.height,
    required this.value,
    required this.coverage,
  });

  final int width;
  final int height;
  final Float64List value;
  final Float64List coverage;
}

typedef DrizzlePoint = ({double x, double y});

/// One sample to splat via [DrizzleAccumulator.addDrops] — the batch
/// form of [DrizzleAccumulator.addDrop]. [dropRadius]/[weight], when
/// `null`, fall back to `addDrops`'s own defaults for the whole batch.
final class DrizzleSample {
  const DrizzleSample({
    required this.outputX,
    required this.outputY,
    required this.value,
    this.dropRadius,
    this.weight,
  });

  final double outputX;
  final double outputY;
  final double value;
  final double? dropRadius;
  final double? weight;
}

/// FP64, flux-conserving drizzle accumulator for one scalar channel.
/// Create one instance per output tile/channel to keep memory bounded.
final class DrizzleAccumulator {
  DrizzleAccumulator({required this.width, required this.height}) {
    if (width <= 0 || height <= 0) {
      throw InvalidDrizzleInput(
        'Drizzle accumulator dimensions must be positive integers.',
      );
    }
    valueSum = Float64List(width * height);
    weightSum = Float64List(width * height);
  }

  final int width;
  final int height;
  late final Float64List valueSum;
  late final Float64List weightSum;
  final Float64List _clipX0 = Float64List(12);
  final Float64List _clipY0 = Float64List(12);
  final Float64List _clipX1 = Float64List(12);
  final Float64List _clipY1 = Float64List(12);

  void addDrop(
    double outputX,
    double outputY,
    double value, {
    double dropRadius = 0.5,
    double weight = 1,
  }) {
    if (!outputX.isFinite ||
        !outputY.isFinite ||
        !value.isFinite ||
        !weight.isFinite ||
        weight < 0 ||
        !dropRadius.isFinite ||
        !(dropRadius > 0)) {
      return;
    }
    final double dropLeft = outputX - dropRadius;
    final double dropRight = outputX + dropRadius;
    final double dropTop = outputY - dropRadius;
    final double dropBottom = outputY + dropRadius;
    final int iMin = math.max(0, (dropLeft - 0.5).floor());
    final int iMax = math.min(width - 1, (dropRight + 0.5).ceil());
    final int jMin = math.max(0, (dropTop - 0.5).floor());
    final int jMax = math.min(height - 1, (dropBottom + 0.5).ceil());
    for (int j = jMin; j <= jMax; j++) {
      final double overlapY = _overlap1D(
        dropTop,
        dropBottom,
        j - 0.5,
        j + 0.5,
      );
      if (overlapY <= 0) continue;
      for (int i = iMin; i <= iMax; i++) {
        final double overlapX = _overlap1D(
          dropLeft,
          dropRight,
          i - 0.5,
          i + 0.5,
        );
        if (overlapX <= 0) continue;
        _accumulate(j * width + i, value, overlapX * overlapY, weight);
      }
    }
  }

  /// Splats every entry of [samples] via [addDrop] (batch form),
  /// matching `drizzle_accumulator_reference.mjs`'s `addDrops`: each
  /// entry's own [DrizzleSample.dropRadius]/[DrizzleSample.weight]
  /// override [dropRadius]/[weight] when non-null, falling back to
  /// those batch-level defaults otherwise. Non-finite or degenerate
  /// invalid numeric entries are silently skipped (via [addDrop]'s own
  /// existing behavior). Finite drops that merely land outside the output
  /// grid are naturally ignored by zero overlap; negative weights are never
  /// allowed to subtract scientific coverage.
  void addDrops(
    List<DrizzleSample> samples, {
    double dropRadius = 0.5,
    double weight = 1,
  }) {
    for (final DrizzleSample sample in samples) {
      addDrop(
        sample.outputX,
        sample.outputY,
        sample.value,
        dropRadius: sample.dropRadius ?? dropRadius,
        weight: sample.weight ?? weight,
      );
    }
  }

  void addRotatedDrop(
    double outputX,
    double outputY,
    double value, {
    double rotationRadians = 0,
    double dropRadius = 0.5,
    double? halfWidth,
    double? halfHeight,
    double weight = 1,
  }) {
    final double effectiveHalfWidth = halfWidth ?? dropRadius;
    final double effectiveHalfHeight = halfHeight ?? dropRadius;
    if (!outputX.isFinite ||
        !outputY.isFinite ||
        !value.isFinite ||
        !weight.isFinite ||
        weight < 0 ||
        !rotationRadians.isFinite ||
        !effectiveHalfWidth.isFinite ||
        !effectiveHalfHeight.isFinite ||
        !(effectiveHalfWidth > 0) ||
        !(effectiveHalfHeight > 0)) {
      return;
    }
    final double cosine = math.cos(rotationRadians);
    final double sine = math.sin(rotationRadians);
    addQuadrilateralDrop(
      outputX - effectiveHalfWidth * cosine + effectiveHalfHeight * sine,
      outputY - effectiveHalfWidth * sine - effectiveHalfHeight * cosine,
      outputX + effectiveHalfWidth * cosine + effectiveHalfHeight * sine,
      outputY + effectiveHalfWidth * sine - effectiveHalfHeight * cosine,
      outputX + effectiveHalfWidth * cosine - effectiveHalfHeight * sine,
      outputY + effectiveHalfWidth * sine + effectiveHalfHeight * cosine,
      outputX - effectiveHalfWidth * cosine - effectiveHalfHeight * sine,
      outputY - effectiveHalfWidth * sine + effectiveHalfHeight * cosine,
      value,
      weight: weight,
    );
  }

  /// Allocation-free hot path for the quadrilateral footprints produced by
  /// CFA drizzle. It is numerically equivalent to [addPolygonDrop], but
  /// reuses fixed clipping buffers instead of creating several Lists for
  /// every source sample and every overlapped output pixel.
  void addQuadrilateralDrop(
    double x0,
    double y0,
    double x1,
    double y1,
    double x2,
    double y2,
    double x3,
    double y3,
    double value, {
    double weight = 1,
  }) {
    if (!x0.isFinite ||
        !y0.isFinite ||
        !x1.isFinite ||
        !y1.isFinite ||
        !x2.isFinite ||
        !y2.isFinite ||
        !x3.isFinite ||
        !y3.isFinite ||
        !value.isFinite ||
        !weight.isFinite ||
        weight < 0) {
      return;
    }
    final double minX = math.min(math.min(x0, x1), math.min(x2, x3));
    final double maxX = math.max(math.max(x0, x1), math.max(x2, x3));
    final double minY = math.min(math.min(y0, y1), math.min(y2, y3));
    final double maxY = math.max(math.max(y0, y1), math.max(y2, y3));
    final int iMin = math.max(0, (minX - 0.5).floor());
    final int iMax = math.min(width - 1, (maxX + 0.5).ceil());
    final int jMin = math.max(0, (minY - 0.5).floor());
    final int jMax = math.min(height - 1, (maxY + 0.5).ceil());
    for (int j = jMin; j <= jMax; j++) {
      for (int i = iMin; i <= iMax; i++) {
        final double area = _clippedQuadrilateralArea(
          x0,
          y0,
          x1,
          y1,
          x2,
          y2,
          x3,
          y3,
          left: i - 0.5,
          right: i + 0.5,
          top: j - 0.5,
          bottom: j + 0.5,
        );
        if (area <= 0) continue;
        _accumulate(j * width + i, value, area, weight);
      }
    }
  }

  double _clippedQuadrilateralArea(
    double x0,
    double y0,
    double x1,
    double y1,
    double x2,
    double y2,
    double x3,
    double y3, {
    required double left,
    required double right,
    required double top,
    required double bottom,
  }) {
    _clipX0[0] = x0;
    _clipY0[0] = y0;
    _clipX0[1] = x1;
    _clipY0[1] = y1;
    _clipX0[2] = x2;
    _clipY0[2] = y2;
    _clipX0[3] = x3;
    _clipY0[3] = y3;
    int count = _clipCoordinates(
      _clipX0,
      _clipY0,
      4,
      _clipX1,
      _clipY1,
      boundary: left,
      vertical: true,
      keepGreater: true,
    );
    if (count < 3) return 0;
    count = _clipCoordinates(
      _clipX1,
      _clipY1,
      count,
      _clipX0,
      _clipY0,
      boundary: right,
      vertical: true,
      keepGreater: false,
    );
    if (count < 3) return 0;
    count = _clipCoordinates(
      _clipX0,
      _clipY0,
      count,
      _clipX1,
      _clipY1,
      boundary: top,
      vertical: false,
      keepGreater: true,
    );
    if (count < 3) return 0;
    count = _clipCoordinates(
      _clipX1,
      _clipY1,
      count,
      _clipX0,
      _clipY0,
      boundary: bottom,
      vertical: false,
      keepGreater: false,
    );
    if (count < 3) return 0;
    double twiceArea = 0;
    int previous = count - 1;
    for (int current = 0; current < count; current++) {
      twiceArea += _clipX0[previous] * _clipY0[current] -
          _clipX0[current] * _clipY0[previous];
      previous = current;
    }
    return twiceArea.abs() * 0.5;
  }

  int _clipCoordinates(
    Float64List inputX,
    Float64List inputY,
    int inputCount,
    Float64List outputX,
    Float64List outputY, {
    required double boundary,
    required bool vertical,
    required bool keepGreater,
  }) {
    int outputCount = 0;
    int previous = inputCount - 1;
    for (int current = 0; current < inputCount; current++) {
      final double previousAxis =
          vertical ? inputX[previous] : inputY[previous];
      final double currentAxis = vertical ? inputX[current] : inputY[current];
      final bool previousInside =
          keepGreater ? previousAxis >= boundary : previousAxis <= boundary;
      final bool currentInside =
          keepGreater ? currentAxis >= boundary : currentAxis <= boundary;
      if (previousInside != currentInside) {
        final double t =
            (boundary - previousAxis) / (currentAxis - previousAxis);
        outputX[outputCount] = vertical
            ? boundary
            : inputX[previous] + t * (inputX[current] - inputX[previous]);
        outputY[outputCount] = vertical
            ? inputY[previous] + t * (inputY[current] - inputY[previous])
            : boundary;
        outputCount++;
      }
      if (currentInside) {
        outputX[outputCount] = inputX[current];
        outputY[outputCount] = inputY[current];
        outputCount++;
      }
      previous = current;
    }
    return outputCount;
  }

  /// Splats an arbitrary convex source footprint already mapped onto this
  /// accumulator's output grid.
  ///
  /// Global + Local Registration can turn a square Drizzle drop into a
  /// locally scaled or sheared quadrilateral. Clipping that measured
  /// footprint directly avoids approximating every pixel with the rotation
  /// sampled at the image origin.
  void addPolygonDrop(
    List<DrizzlePoint> polygon,
    double value, {
    double weight = 1,
  }) {
    if (polygon.length < 3 ||
        !value.isFinite ||
        !weight.isFinite ||
        weight < 0) {
      return;
    }
    for (final DrizzlePoint point in polygon) {
      if (!point.x.isFinite || !point.y.isFinite) return;
    }
    double minX = double.infinity;
    double maxX = double.negativeInfinity;
    double minY = double.infinity;
    double maxY = double.negativeInfinity;
    for (final DrizzlePoint point in polygon) {
      minX = math.min(minX, point.x);
      maxX = math.max(maxX, point.x);
      minY = math.min(minY, point.y);
      maxY = math.max(maxY, point.y);
    }
    final int iMin = math.max(0, (minX - 0.5).floor());
    final int iMax = math.min(width - 1, (maxX + 0.5).ceil());
    final int jMin = math.max(0, (minY - 0.5).floor());
    final int jMax = math.min(height - 1, (maxY + 0.5).ceil());
    for (int j = jMin; j <= jMax; j++) {
      for (int i = iMin; i <= iMax; i++) {
        final List<DrizzlePoint> clipped = _clipPolygonToRectangle(
          polygon,
          left: i - 0.5,
          right: i + 0.5,
          top: j - 0.5,
          bottom: j + 0.5,
        );
        final double area = _polygonArea(clipped);
        if (area <= 0) continue;
        _accumulate(j * width + i, value, area, weight);
      }
    }
  }

  DrizzleResult finalize() {
    final Float64List value = Float64List(width * height);
    final Float64List coverage = Float64List(width * height);
    for (int index = 0; index < value.length; index++) {
      final double weight = weightSum[index];
      coverage[index] = weight;
      value[index] = weight > 0 ? valueSum[index] / weight : 0;
    }
    return DrizzleResult(
      width: width,
      height: height,
      value: value,
      coverage: coverage,
    );
  }

  void _accumulate(int index, double value, double area, double weight) {
    valueSum[index] += value * area * weight;
    weightSum[index] += area * weight;
  }
}

double _overlap1D(double aMin, double aMax, double bMin, double bMax) =>
    math.max(0, math.min(aMax, bMax) - math.max(aMin, bMin));

List<DrizzlePoint> _clipPolygonToRectangle(
  List<DrizzlePoint> points, {
  required double left,
  required double right,
  required double top,
  required double bottom,
}) {
  List<DrizzlePoint> clipped = points;
  clipped = _clipVertical(clipped, boundary: left, keepGreater: true);
  clipped = _clipVertical(clipped, boundary: right, keepGreater: false);
  clipped = _clipHorizontal(clipped, boundary: top, keepGreater: true);
  clipped = _clipHorizontal(clipped, boundary: bottom, keepGreater: false);
  return clipped;
}

List<DrizzlePoint> _clipVertical(
  List<DrizzlePoint> points, {
  required double boundary,
  required bool keepGreater,
}) =>
    _clipHalfPlane(
      points,
      isInside: (DrizzlePoint point) =>
          keepGreater ? point.x >= boundary : point.x <= boundary,
      intersection: (DrizzlePoint a, DrizzlePoint b) {
        final double t = (boundary - a.x) / (b.x - a.x);
        return (x: boundary, y: a.y + t * (b.y - a.y));
      },
    );

List<DrizzlePoint> _clipHorizontal(
  List<DrizzlePoint> points, {
  required double boundary,
  required bool keepGreater,
}) =>
    _clipHalfPlane(
      points,
      isInside: (DrizzlePoint point) =>
          keepGreater ? point.y >= boundary : point.y <= boundary,
      intersection: (DrizzlePoint a, DrizzlePoint b) {
        final double t = (boundary - a.y) / (b.y - a.y);
        return (x: a.x + t * (b.x - a.x), y: boundary);
      },
    );

List<DrizzlePoint> _clipHalfPlane(
  List<DrizzlePoint> points, {
  required bool Function(DrizzlePoint point) isInside,
  required DrizzlePoint Function(DrizzlePoint a, DrizzlePoint b) intersection,
}) {
  if (points.isEmpty) return points;
  final List<DrizzlePoint> output = <DrizzlePoint>[];
  for (int index = 0; index < points.length; index++) {
    final DrizzlePoint current = points[index];
    final DrizzlePoint previous =
        points[(index - 1 + points.length) % points.length];
    final bool currentInside = isInside(current);
    final bool previousInside = isInside(previous);
    if (currentInside) {
      if (!previousInside) output.add(intersection(previous, current));
      output.add(current);
    } else if (previousInside) {
      output.add(intersection(previous, current));
    }
  }
  return output;
}

double _polygonArea(List<DrizzlePoint> points) {
  if (points.length < 3) return 0;
  double sum = 0;
  for (int index = 0; index < points.length; index++) {
    final DrizzlePoint current = points[index];
    final DrizzlePoint next = points[(index + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return sum.abs() / 2;
}
