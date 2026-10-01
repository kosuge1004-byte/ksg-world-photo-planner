import 'dart:typed_data';

import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../registration/affine_sampling_transform.dart';

/// Work353: focus-stack photometric normalization.
///
/// Dart port of `tool/raw_samples/focus_photometric_gain_reference.mjs`
/// (tested there and in `test/focus_photometric_normalization_test.dart`).
///
/// Frames of a focus bracket can differ in brightness/colour (effective
/// aperture changes with magnification, LED flicker, per-frame white
/// balance). The blend switches frames per pixel, so such differences show
/// as blotches or steps along winner-map boundaries. Defocus conserves the
/// local mean over blocks much larger than the blur, so the median
/// per-channel ratio of block means (reference / aligned frame) estimates
/// each frame's gain. Opt-in; with it off the blend is bit-identical.
final class FocusFrameGain {
  const FocusFrameGain(this.r, this.g, this.b, {required this.applied});

  static const FocusFrameGain unit = FocusFrameGain(1, 1, 1, applied: false);

  final double r;
  final double g;
  final double b;

  /// Whether the estimate was accepted (false => unit gain).
  final bool applied;

  List<double> toJson() => <double>[r, g, b];
}

class InvalidFocusGainInput extends ArgumentError {
  InvalidFocusGainInput(super.message);
}

double _median(List<double> values) {
  final List<double> s = <double>[...values]..sort();
  final int n = s.length;
  return n.isOdd ? s[(n - 1) ~/ 2] : (s[n ~/ 2 - 1] + s[n ~/ 2]) / 2;
}

/// Pure estimator over paired block means (`[r, g, b]` each). See the Node
/// reference for the exact contract.
FocusFrameGain estimateFocusFrameGain(
  List<List<double>> referenceMeans,
  List<List<double>> frameMeans, {
  double low = 0.01,
  double high = 0.8,
  int minValid = 30,
  double minGain = 0.5,
  double maxGain = 2,
}) {
  if (referenceMeans.length != frameMeans.length) {
    throw InvalidFocusGainInput('Block counts differ.');
  }
  if (!(low > 0 && high > low && high <= 1) ||
      minValid < 1 ||
      !(minGain > 0 && maxGain > minGain)) {
    throw InvalidFocusGainInput('Invalid gain parameters.');
  }
  final List<List<double>> ratios = <List<double>>[
    <double>[],
    <double>[],
    <double>[],
  ];
  for (int i = 0; i < referenceMeans.length; i++) {
    final List<double> r = referenceMeans[i];
    final List<double> f = frameMeans[i];
    bool ok = true;
    for (int c = 0; c < 3; c++) {
      if (!r[c].isFinite ||
          !f[c].isFinite ||
          r[c] < low ||
          r[c] > high ||
          f[c] < low ||
          f[c] > high) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (int c = 0; c < 3; c++) {
      ratios[c].add(r[c] / f[c]);
    }
  }
  if (ratios[0].length < minValid) return FocusFrameGain.unit;
  final List<double> gain = <double>[for (final List<double> v in ratios) _median(v)];
  if (!gain.every((double g) => g >= minGain && g <= maxGain)) {
    return FocusFrameGain.unit;
  }
  return FocusFrameGain(gain[0], gain[1], gain[2], applied: true);
}

/// Output-grid block centres (same rule as the Node reference).
List<({int x, int y})> focusGainBlockCentres(
  int width,
  int height, {
  int columns = 48,
  int rows = 32,
  int blockSize = 32,
}) {
  final List<({int x, int y})> centres = <({int x, int y})>[];
  for (int r = 0; r < rows; r++) {
    for (int c = 0; c < columns; c++) {
      final int x = ((c + 0.5) * width / columns).round();
      final int y = ((r + 0.5) * height / rows).round();
      if (x - blockSize ~/ 2 < 0 ||
          y - blockSize ~/ 2 < 0 ||
          x + blockSize ~/ 2 > width ||
          y + blockSize ~/ 2 > height) {
        continue;
      }
      centres.add((x: x, y: y));
    }
  }
  return centres;
}

Future<List<double>?> _blockMean(
  LinearRgbTileStore store,
  double centerX,
  double centerY,
  int blockSize,
) async {
  final int left = (centerX - blockSize / 2).round();
  final int top = (centerY - blockSize / 2).round();
  if (left < 0 ||
      top < 0 ||
      left + blockSize > store.width ||
      top + blockSize > store.height) {
    return null;
  }
  final LinearRgbTile tile = await store.readRegion(
    x: left,
    y: top,
    width: blockSize,
    height: blockSize,
  );
  final Float32List rgb = tile.interleavedRgb;
  double r = 0, g = 0, b = 0;
  for (int i = 0; i < rgb.length; i += 3) {
    r += rgb[i];
    g += rgb[i + 1];
    b += rgb[i + 2];
  }
  final int n = rgb.length ~/ 3;
  return <double>[r / n, g / n, b / n];
}

/// Estimates one gain per frame. `stores[0]` is the reference (unit gain);
/// frame blocks are read at the block centre mapped through the frame's
/// output->source [samplingTransforms] (block means tolerate the residual
/// sub-block misalignment).
Future<List<FocusFrameGain>> estimateFocusFrameGains({
  required List<LinearRgbTileStore> stores,
  required List<AffineSamplingTransform> samplingTransforms,
  int columns = 48,
  int rows = 32,
  int blockSize = 32,
  bool Function()? isCancelled,
}) async {
  if (stores.length != samplingTransforms.length || stores.isEmpty) {
    throw InvalidFocusGainInput('Stores and transforms must match.');
  }
  final LinearRgbTileStore reference = stores.first;
  final List<({int x, int y})> centres = focusGainBlockCentres(
    reference.width,
    reference.height,
    columns: columns,
    rows: rows,
    blockSize: blockSize,
  );
  final List<List<double>?> referenceMeans = <List<double>?>[
    for (final ({int x, int y}) c in centres)
      await _blockMean(reference, c.x.toDouble(), c.y.toDouble(), blockSize),
  ];
  final List<FocusFrameGain> gains = <FocusFrameGain>[FocusFrameGain.unit];
  for (int frame = 1; frame < stores.length; frame++) {
    if (isCancelled?.call() ?? false) {
      throw StateError('Focus gain estimation was cancelled.');
    }
    final AffineSamplingTransform t = samplingTransforms[frame];
    final List<List<double>> ref = <List<double>>[];
    final List<List<double>> own = <List<double>>[];
    for (int i = 0; i < centres.length; i++) {
      final List<double>? r = referenceMeans[i];
      if (r == null) continue;
      final double x = centres[i].x.toDouble();
      final double y = centres[i].y.toDouble();
      final List<double>? f = await _blockMean(
        stores[frame],
        t.sourceX(x, y),
        t.sourceY(x, y),
        blockSize,
      );
      if (f == null) continue;
      ref.add(r);
      own.add(f);
    }
    gains.add(estimateFocusFrameGain(ref, own));
  }
  return gains;
}

/// Multiplies an interleaved RGB buffer in place by [gain].
void applyFocusFrameGainInPlace(Float32List rgb, FocusFrameGain gain) {
  if (!gain.applied) return;
  for (int i = 0; i < rgb.length; i += 3) {
    rgb[i] = rgb[i] * gain.r;
    rgb[i + 1] = rgb[i + 1] * gain.g;
    rgb[i + 2] = rgb[i + 2] * gain.b;
  }
}
