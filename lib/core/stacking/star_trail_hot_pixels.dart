import 'dart:math' as math;
import 'dart:typed_data';

import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';

/// Work355: star-trail stationary hot-pixel removal.
///
/// Dart port of `tool/raw_samples/star_trail_hot_pixel_reference.mjs`
/// (tests there and in `test/star_trail_hot_pixels_test.dart`).
///
/// In a comparison-light (per-pixel maximum) stack a hot pixel that fires in
/// even one frame survives. The background worker path cannot run
/// master-dark hot-pixel detection and no RAW defect map is ever populated,
/// so star trails kept every hot pixel. Detection here is temporal: pass 1
/// (which already decodes every frame) records sharp isolated maxima per
/// frame; stars move across the sensor while hot pixels stay put, so pixels
/// flagged in >= [defaultHotPixelFraction] of the frames (sequences of at
/// least [defaultHotPixelMinFrames]) form the hot map. Pass 2 replaces each
/// hot pixel's 3x3 demosaic footprint with the per-channel median of the
/// 16-pixel ring around it before the frame enters the maximum.

const int defaultHotPixelMinFrames = 20;
const double defaultHotPixelFraction = 0.7;

/// Read margin that makes [HotPixelCorrectedRgbStore] tile-invariant: a hot
/// pixel one pixel outside a region changes the region's edge pixel and
/// needs its ring two pixels further out.
const int _correctionMargin = 3;

class InvalidHotPixelInput extends ArgumentError {
  InvalidHotPixelInput(super.message);
}

const List<(int, int)> _ring = <(int, int)>[
  (-2, -2), (-1, -2), (0, -2), (1, -2), (2, -2), //
  (-2, -1), (2, -1), (-2, 0), (2, 0), (-2, 1), (2, 1), //
  (-2, 2), (-1, 2), (0, 2), (1, 2), (2, 2),
];

double _median(List<double> values) {
  final List<double> s = <double>[...values]..sort();
  final int n = s.length;
  return n.isOdd ? s[(n - 1) ~/ 2] : (s[n ~/ 2 - 1] + s[n ~/ 2]) / 2;
}

/// Per-frame candidates on an in-memory interleaved RGB image. Pixel
/// indices are relative to this image (row-major). Sorted ascending.
Int32List detectStationaryPointCandidatesInImage(
  Float32List rgb,
  int width,
  int height, {
  double sigmaK = 8,
  double sharpness = 2.5,
  int maxCandidates = 100000,
  double? noiseSigma,
}) {
  if (rgb.length != width * height * 3 || width < 5 || height < 5) {
    throw InvalidHotPixelInput('Invalid image.');
  }
  final Float32List l = Float32List(width * height);
  for (int i = 0; i < l.length; i++) {
    l[i] = math.max(rgb[i * 3], math.max(rgb[i * 3 + 1], rgb[i * 3 + 2]));
  }
  final double sigma = noiseSigma ?? estimateLuminanceNoiseSigma(l, width, height);
  final List<int> out = <int>[];
  final List<double> ring = List<double>.filled(_ring.length, 0);
  for (int y = 2; y < height - 2; y++) {
    for (int x = 2; x < width - 2; x++) {
      final int p = y * width + x;
      final double v = l[p];
      bool isMax = true;
      double nSum = 0;
      for (int dy = -1; dy <= 1 && isMax; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          if (dx == 0 && dy == 0) continue;
          final double q = l[(y + dy) * width + x + dx];
          if (q > v || (q == v && (dy < 0 || (dy == 0 && dx < 0)))) {
            isMax = false;
            break;
          }
          nSum += q;
        }
      }
      if (!isMax) continue;
      for (int k = 0; k < _ring.length; k++) {
        ring[k] = l[(y + _ring[k].$2) * width + x + _ring[k].$1];
      }
      final double bg = _median(ring);
      final double peak = v - bg;
      if (!(peak > sigmaK * sigma)) continue;
      final double neighbourExcess = math.max(0.0, nSum / 8 - bg);
      if (!(peak >= sharpness * neighbourExcess)) continue;
      out.add(p);
      if (out.length >= maxCandidates) return Int32List.fromList(out);
    }
  }
  return Int32List.fromList(out);
}

/// Robust per-image noise of the max-channel luminance from horizontal
/// first differences on a 4x4 subsample.
double estimateLuminanceNoiseSigma(Float32List l, int width, int height) {
  final List<double> diffs = <double>[];
  for (int y = 0; y < height; y += 4) {
    for (int x = 1; x < width; x += 4) {
      diffs.add(l[y * width + x] - l[y * width + x - 1]);
    }
  }
  final double med = _median(diffs);
  return math.max(
    1e-6,
    1.4826 *
        _median(<double>[for (final double d in diffs) (d - med).abs()]) /
        math.sqrt2,
  );
}

/// Candidates for a whole store, scanned in horizontal strips (two-pixel
/// overlap so every pixel is tested with its full 5x5 neighbourhood).
/// Returned indices are global (`y * store.width + x`), sorted. The noise
/// estimate comes from the first strip so all strips use the same sigma.
Future<Int32List> detectStationaryPointCandidates(
  LinearRgbTileStore store, {
  int stripHeight = 256,
  int maxCandidates = 100000,
  bool Function()? isCancelled,
}) async {
  final int width = store.width;
  final int height = store.height;
  if (width < 5 || height < 5) return Int32List(0);
  final List<int> all = <int>[];
  double? sigma;
  for (int top = 0; top < height; top += stripHeight) {
    if (isCancelled?.call() ?? false) {
      throw StateError('Hot-pixel detection was cancelled.');
    }
    final int readTop = math.max(0, top - 2);
    final int readBottom = math.min(height, top + stripHeight + 2);
    final LinearRgbTile strip = await store.readRegion(
      x: 0,
      y: readTop,
      width: width,
      height: readBottom - readTop,
    );
    final int stripRows = readBottom - readTop;
    if (stripRows < 5) continue;
    if (sigma == null) {
      final Float32List l = Float32List(width * stripRows);
      final Float32List rgb = strip.interleavedRgb;
      for (int i = 0; i < l.length; i++) {
        l[i] = math.max(rgb[i * 3], math.max(rgb[i * 3 + 1], rgb[i * 3 + 2]));
      }
      sigma = estimateLuminanceNoiseSigma(l, width, stripRows);
    }
    final Int32List local = detectStationaryPointCandidatesInImage(
      strip.interleavedRgb,
      width,
      stripRows,
      noiseSigma: sigma,
      maxCandidates: maxCandidates,
    );
    for (final int p in local) {
      final int y = readTop + p ~/ width;
      // Each row is owned by exactly one strip.
      if (y < top || y >= top + stripHeight) continue;
      all.add(y * width + p % width);
      if (all.length >= maxCandidates) return Int32List.fromList(all);
    }
  }
  return Int32List.fromList(all);
}

/// Hot map: pixels present in >= [fraction] of [perFrame] lists (at least 3),
/// only when there are at least [minFrames] lists. Sorted ascending.
Int32List buildStationaryHotPixelMap(
  List<Int32List> perFrame, {
  int minFrames = defaultHotPixelMinFrames,
  double fraction = defaultHotPixelFraction,
}) {
  if (!(fraction > 0 && fraction <= 1) || minFrames < 1) {
    throw InvalidHotPixelInput('Invalid parameters.');
  }
  if (perFrame.length < minFrames) return Int32List(0);
  final int need = math.max(3, (fraction * perFrame.length).ceil());
  final Map<int, int> counts = <int, int>{};
  for (final Int32List list in perFrame) {
    for (final int p in list) {
      counts[p] = (counts[p] ?? 0) + 1;
    }
  }
  final List<int> hot = <int>[
    for (final MapEntry<int, int> e in counts.entries)
      if (e.value >= need) e.key,
  ]..sort();
  return Int32List.fromList(hot);
}

/// Corrected copy of an interleaved region whose top-left pixel is
/// ([x0], [y0]) in an image [imageWidth] pixels wide. [hot] holds global
/// indices (sorted or not). Ring medians are taken from the uncorrected input.
Float32List correctHotPixelsInRegion(
  Float32List rgb,
  int width,
  int height,
  Iterable<int> hot, {
  int x0 = 0,
  int y0 = 0,
  int? imageWidth,
}) {
  final int iw = imageWidth ?? width;
  final Float32List out = Float32List.fromList(rgb);
  final List<double> ring = List<double>.filled(_ring.length, 0);
  for (final int g in hot) {
    final int x = g % iw - x0;
    final int y = g ~/ iw - y0;
    if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) continue;
    for (int c = 0; c < 3; c++) {
      for (int k = 0; k < _ring.length; k++) {
        ring[k] = rgb[((y + _ring[k].$2) * width + x + _ring[k].$1) * 3 + c];
      }
      final double m = _median(ring);
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          out[((y + dy) * width + x + dx) * 3 + c] = m;
        }
      }
    }
  }
  return out;
}

/// Read-only view of a committed [source] store with [hotPixels] (sorted
/// global indices) corrected on every read. Writes are not supported;
/// [dispose] does not dispose [source] (its owner does).
final class HotPixelCorrectedRgbStore implements LinearRgbTileStore {
  HotPixelCorrectedRgbStore(this.source, this.hotPixels);

  final LinearRgbTileStore source;
  final Int32List hotPixels;

  @override
  int get width => source.width;

  @override
  int get height => source.height;

  @override
  int get persistentByteLength => source.persistentByteLength;

  @override
  int get completedTileCount => source.completedTileCount;

  @override
  bool get isCommitted => source.isCommitted;

  int _lowerBound(int value) {
    int lo = 0;
    int hi = hotPixels.length;
    while (lo < hi) {
      final int mid = (lo + hi) >> 1;
      if (hotPixels[mid] < value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  @override
  Future<LinearRgbTile> readRegion({
    required int x,
    required int y,
    required int width,
    required int height,
  }) async {
    if (hotPixels.isEmpty) {
      return source.readRegion(x: x, y: y, width: width, height: height);
    }
    final int ex0 = math.max(0, x - _correctionMargin);
    final int ey0 = math.max(0, y - _correctionMargin);
    final int ex1 = math.min(source.width, x + width + _correctionMargin);
    final int ey1 = math.min(source.height, y + height + _correctionMargin);
    final int start = _lowerBound(ey0 * source.width);
    final int end = _lowerBound(ey1 * source.width);
    final List<int> inside = <int>[
      for (int i = start; i < end; i++)
        if (hotPixels[i] % source.width >= ex0 &&
            hotPixels[i] % source.width < ex1)
          hotPixels[i],
    ];
    if (inside.isEmpty) {
      return source.readRegion(x: x, y: y, width: width, height: height);
    }
    final int ew = ex1 - ex0;
    final int eh = ey1 - ey0;
    final LinearRgbTile extended =
        await source.readRegion(x: ex0, y: ey0, width: ew, height: eh);
    final Float32List corrected = correctHotPixelsInRegion(
      extended.interleavedRgb,
      ew,
      eh,
      inside,
      x0: ex0,
      y0: ey0,
      imageWidth: source.width,
    );
    final Float32List cropped = Float32List(width * height * 3);
    for (int row = 0; row < height; row++) {
      final int from = ((row + y - ey0) * ew + (x - ex0)) * 3;
      cropped.setRange(row * width * 3, (row + 1) * width * 3, corrected, from);
    }
    return LinearRgbTile(
      x: x,
      y: y,
      width: width,
      height: height,
      interleavedRgb: cropped,
    );
  }

  @override
  Future<void> writeTile(LinearRgbTile tile) =>
      throw UnsupportedError('HotPixelCorrectedRgbStore is read-only.');

  @override
  Future<void> commit() async {}

  @override
  Future<void> abort() async {}

  @override
  Future<void> dispose() async {}
}
