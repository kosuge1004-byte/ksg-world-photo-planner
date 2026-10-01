import '../image/linear_raw_mosaic.dart';
import 'raw_defect_map.dart';

/// Dart port of `tool/raw_samples/hot_pixel_detection_reference.mjs`.
///
/// Closes a real, previously-dormant gap this project's own defect-
/// pixel correction stage had: [RawDefectMap]'s own documented design
/// deliberately holds only *explicitly provided* defect coordinates
/// (from camera/RAW metadata), specifically because automatically
/// detecting "unusually bright" pixels from a single *light* frame
/// risks mistaking real stars or point sources for defects. Because of
/// that restriction, and because nothing in this project ever actually
/// populated a defect map from camera metadata either,
/// `phase2_quality_pipeline_factory.dart`'s own `_defectPixelStage` has
/// been present in the pipeline's architecture since early in this
/// project but has *never actually corrected anything* — `context.
/// rawDefectMap` is set to `null` on cleanup and never assigned a real
/// value anywhere else in the codebase.
///
/// A **master dark frame** (`dark_frame_subtraction.dart`'s own
/// `computeMasterDark`, Work96) sidesteps the exact concern that
/// motivated the light-frame restriction: a dark frame has no possible
/// astronomical content to mistake for a defect. Detecting unusually
/// bright pixels in a master dark is therefore safe in a way detecting
/// them in a light frame is not.
///
/// [detectHotPixelsFromMasterDark] flags a pixel when its own value
/// clears *both* a relative threshold (at least [ratioThreshold] times
/// its local same-CFA-phase neighborhood's median) *and* an absolute
/// threshold (exceeds that median by at least [absoluteThreshold]) —
/// see the Node reference's own doc comment for why both, independently,
/// matter.
///
/// This file has not been executed against the Dart SDK. It is a
/// careful line-by-line translation of the Node reference, which has
/// full test coverage. Run `test/hot_pixel_detection_test.dart` before
/// relying on this in production.

class InvalidHotPixelDetectionInput extends ArgumentError {
  InvalidHotPixelDetectionInput(String super.message);
}

bool _isSameCfaPhase(int ax, int ay, int bx, int by) {
  // 標準的な2x2 Bayerパターンは全て周期2で繰り返すため、2つの位置が
  // 同じCFA位相を共有するのは、x方向・y方向それぞれの偶奇が一致する
  // 場合に限られる — これは4パターン(rggb/bggr/grbg/gbrg)いずれでも
  // 成り立つため、CfaPattern自体は引数に取らない。
  return (ax.isEven == bx.isEven) && (ay.isEven == by.isEven);
}

double _median(List<double> values) {
  final List<double> sorted = List<double>.of(values)..sort();
  final int middle = sorted.length >> 1;
  return sorted.length.isOdd
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
}

/// Detects hot pixels in [masterDark] (already black-level-subtracted —
/// matching `prepareMasterDark`'s own output), returning a
/// [RawDefectMap].
///
/// - [neighborhoodRadius] (default `5`): same-CFA-phase neighbors are
///   searched within a `(2*neighborhoodRadius+1)` square window
///   (Chebyshev distance), edge-clamped.
/// - [ratioThreshold] (default `5`), [absoluteThreshold] (default `0`):
///   see this file's own doc comment.
///
/// Unlike the Node reference (which additionally validates
/// [masterDark]'s own sample count against its dimensions and that
/// [neighborhoodRadius] is an integer), this Dart port has no such
/// checks: [LinearRawMosaic]'s own constructor already enforces
/// dimension/sample-count consistency, and [neighborhoodRadius] is
/// itself typed `int` — the same "Node-level validation made
/// unreachable by Dart's own type system" situation this project's
/// other ports have documented before.
RawDefectMap detectHotPixelsFromMasterDark(
  LinearRawMosaic masterDark, {
  int neighborhoodRadius = 5,
  double ratioThreshold = 5,
  double absoluteThreshold = 0,
}) {
  if (neighborhoodRadius < 1) {
    throw InvalidHotPixelDetectionInput(
      'neighborhoodRadius must be a positive integer.',
    );
  }
  if (!ratioThreshold.isFinite || !(ratioThreshold > 1)) {
    throw InvalidHotPixelDetectionInput(
      'ratioThreshold must be greater than 1.',
    );
  }
  if (!absoluteThreshold.isFinite || !(absoluteThreshold >= 0)) {
    throw InvalidHotPixelDetectionInput(
      'absoluteThreshold must be non-negative.',
    );
  }

  if (masterDark.samples.any((double value) => !value.isFinite)) {
    throw InvalidHotPixelDetectionInput(
      'Master dark must contain only finite samples.',
    );
  }

  final int width = masterDark.width;
  final int height = masterDark.height;
  final List<RawDefectPoint> hotPixels = <RawDefectPoint>[];
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      final double ownValue = masterDark.samples[y * width + x];
      final List<double> neighborValues = <double>[];
      final int minY = (y - neighborhoodRadius).clamp(0, height - 1);
      final int maxY = (y + neighborhoodRadius).clamp(0, height - 1);
      final int minX = (x - neighborhoodRadius).clamp(0, width - 1);
      final int maxX = (x + neighborhoodRadius).clamp(0, width - 1);
      for (int ny = minY; ny <= maxY; ny++) {
        for (int nx = minX; nx <= maxX; nx++) {
          if (nx == x && ny == y) continue;
          if (!_isSameCfaPhase(x, y, nx, ny)) continue;
          neighborValues.add(masterDark.samples[ny * width + nx]);
        }
      }
      if (neighborValues.isEmpty) continue;
      final double localMedian = _median(neighborValues);
      final bool passesRatio = ownValue >= localMedian * ratioThreshold;
      final bool passesAbsolute = ownValue >= localMedian + absoluteThreshold;
      if (passesRatio && passesAbsolute) {
        hotPixels.add(RawDefectPoint(x: x, y: y));
      }
    }
  }
  return RawDefectMap(hotPixels);
}
