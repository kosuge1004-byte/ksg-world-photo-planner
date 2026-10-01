import 'dart:math' as math;
import 'dart:typed_data';

/// Work354: focus-stack multi-band (Laplacian pyramid) blending.
///
/// Dart port of `tool/raw_samples/focus_pyramid_blend_reference.mjs`
/// (tests: `tool/raw_samples/test/focus_pyramid_blend_reference.test.mjs`,
/// `test/focus_pyramid_blend_test.dart`).
///
/// The depth-map blend switches frames per pixel, so brightness or
/// defocus-blur mismatch between winning frames shows as seams along
/// winner-map boundaries. Burt-Adelson blending combines each Laplacian band
/// of every frame with the Gaussian-reduced weight map of that band: fine
/// detail keeps the sharp per-pixel choice, low frequencies transition
/// smoothly.
///
/// Tiling is exact: the 5-tap binomial kernel has finite support, so each
/// pixel depends only on inputs within [focusPyramidDependencyRadius].
/// Every tile is processed over [focusPyramidRegion], whose origin is a
/// multiple of 2^levels (shared decimation grid) and whose margin exceeds
/// that radius; core pixels are then independent of the tiling (verified to
/// be exactly equal in the Node reference).

const int focusPyramidLevels = 5;
const int focusPyramidMargin = 136;
const int focusPyramidCoreTileSize = 256;

const List<double> _k = <double>[1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

int focusPyramidDependencyRadius(int levels) => 4 * (1 << levels);

/// Extended processing region for an output tile.
({int x, int y, int width, int height}) focusPyramidRegion({
  required int tileX,
  required int tileY,
  required int tileWidth,
  required int tileHeight,
  required int imageWidth,
  required int imageHeight,
  int levels = focusPyramidLevels,
  int margin = focusPyramidMargin,
}) {
  final int a = 1 << levels;
  final int x0 = math.max(0, ((tileX - margin) / a).floor() * a);
  final int y0 = math.max(0, ((tileY - margin) / a).floor() * a);
  final int x1 = math.min(imageWidth, tileX + tileWidth + margin);
  final int y1 = math.min(imageHeight, tileY + tileHeight + margin);
  return (x: x0, y: y0, width: x1 - x0, height: y1 - y0);
}

int _reflect(int i, int n) {
  if (n == 1) return 0;
  int v = i;
  while (v < 0 || v >= n) {
    if (v < 0) v = -v;
    if (v >= n) v = 2 * (n - 1) - v;
  }
  return v;
}

final class _Plane {
  _Plane(this.w, this.h, this.data);
  final int w;
  final int h;
  final Float64List data;
}

_Plane _reduce(_Plane p) {
  final int w2 = (p.w + 1) ~/ 2;
  final int h2 = (p.h + 1) ~/ 2;
  final Float64List tmp = Float64List(w2 * p.h);
  for (int y = 0; y < p.h; y++) {
    final int row = y * p.w;
    for (int x = 0; x < w2; x++) {
      double s = 0;
      for (int m = -2; m <= 2; m++) {
        s += _k[m + 2] * p.data[row + _reflect(2 * x + m, p.w)];
      }
      tmp[y * w2 + x] = s;
    }
  }
  final Float64List out = Float64List(w2 * h2);
  for (int y = 0; y < h2; y++) {
    for (int x = 0; x < w2; x++) {
      double s = 0;
      for (int m = -2; m <= 2; m++) {
        s += _k[m + 2] * tmp[_reflect(2 * y + m, p.h) * w2 + x];
      }
      out[y * w2 + x] = s;
    }
  }
  return _Plane(w2, h2, out);
}

_Plane _expand(_Plane c, int w, int h) {
  final Float64List tmp = Float64List(w * c.h);
  for (int y = 0; y < c.h; y++) {
    for (int x = 0; x < w; x++) {
      double s = 0;
      for (int m = -2; m <= 2; m++) {
        final int t = x - m;
        if (t.isOdd) continue;
        s += _k[m + 2] * c.data[y * c.w + _reflect(t ~/ 2, c.w)];
      }
      tmp[y * w + x] = 2 * s;
    }
  }
  final Float64List out = Float64List(w * h);
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      double s = 0;
      for (int m = -2; m <= 2; m++) {
        final int t = y - m;
        if (t.isOdd) continue;
        s += _k[m + 2] * tmp[_reflect(t ~/ 2, c.h) * w + x];
      }
      out[y * w + x] = 2 * s;
    }
  }
  return _Plane(w, h, out);
}

List<_Plane> _gaussianPyramid(_Plane p, int levels) {
  final List<_Plane> g = <_Plane>[p];
  for (int l = 0; l < levels; l++) {
    g.add(_reduce(g[l]));
  }
  return g;
}

/// Blends [frameCount] frames over a [width] x [height] region.
///
/// [interleavedRgb] holds one interleaved RGB buffer per frame;
/// [interleavedWeights] holds `pixel * frameCount + frame` weights that sum
/// to one per pixel (the depth-map blend weights). Returns interleaved RGB
/// (Float32) of the same size.
Float32List focusPyramidBlend({
  required int width,
  required int height,
  required List<Float32List> interleavedRgb,
  required Float32List interleavedWeights,
  int levels = focusPyramidLevels,
}) {
  final int frameCount = interleavedRgb.length;
  final int pixels = width * height;
  if (width <= 0 ||
      height <= 0 ||
      frameCount < 1 ||
      levels < 1 ||
      interleavedWeights.length != pixels * frameCount ||
      interleavedRgb.any((Float32List f) => f.length != pixels * 3)) {
    throw ArgumentError('Invalid focus pyramid-blend input.');
  }
  _Plane weightPlane(int frame) {
    final Float64List d = Float64List(pixels);
    for (int i = 0; i < pixels; i++) {
      d[i] = interleavedWeights[i * frameCount + frame];
    }
    return _Plane(width, height, d);
  }

  // Pass 1: per-level weight sums (1 up to rounding; normalized anyway).
  List<Float64List>? weightSums;
  for (int f = 0; f < frameCount; f++) {
    final List<_Plane> pyr = _gaussianPyramid(weightPlane(f), levels);
    weightSums ??= <Float64List>[
      for (final _Plane p in pyr) Float64List(p.data.length),
    ];
    for (int l = 0; l <= levels; l++) {
      final Float64List s = weightSums[l];
      final Float64List d = pyr[l].data;
      for (int i = 0; i < s.length; i++) {
        s[i] += d[i];
      }
    }
  }
  final List<Float64List> sums = weightSums!;

  final Float32List output = Float32List(pixels * 3);
  for (int c = 0; c < 3; c++) {
    List<Float64List>? acc;
    List<(int, int)>? sizes;
    for (int f = 0; f < frameCount; f++) {
      final List<_Plane> wPyr = _gaussianPyramid(weightPlane(f), levels);
      final Float32List rgb = interleavedRgb[f];
      final Float64List channel = Float64List(pixels);
      for (int i = 0; i < pixels; i++) {
        channel[i] = rgb[i * 3 + c];
      }
      final List<_Plane> g =
          _gaussianPyramid(_Plane(width, height, channel), levels);
      sizes ??= <(int, int)>[for (final _Plane p in g) (p.w, p.h)];
      acc ??= <Float64List>[for (final _Plane p in g) Float64List(p.data.length)];
      for (int l = 0; l <= levels; l++) {
        final Float64List band;
        if (l < levels) {
          final _Plane e = _expand(g[l + 1], g[l].w, g[l].h);
          band = Float64List(g[l].data.length);
          for (int i = 0; i < band.length; i++) {
            band[i] = g[l].data[i] - e.data[i];
          }
        } else {
          band = g[levels].data;
        }
        final Float64List a = acc[l];
        final Float64List wl = wPyr[l].data;
        final Float64List s = sums[l];
        for (int i = 0; i < a.length; i++) {
          if (s[i] > 0) a[i] += (wl[i] / s[i]) * band[i];
        }
      }
    }
    final List<Float64List> bands = acc!;
    final List<(int, int)> levelSizes = sizes!;
    _Plane cur =
        _Plane(levelSizes[levels].$1, levelSizes[levels].$2, bands[levels]);
    for (int l = levels - 1; l >= 0; l--) {
      final _Plane e = _expand(cur, levelSizes[l].$1, levelSizes[l].$2);
      final Float64List d = e.data;
      final Float64List b = bands[l];
      for (int i = 0; i < d.length; i++) {
        d[i] += b[i];
      }
      cur = _Plane(levelSizes[l].$1, levelSizes[l].$2, d);
    }
    for (int i = 0; i < pixels; i++) {
      output[i * 3 + c] = cur.data[i];
    }
  }
  return output;
}
