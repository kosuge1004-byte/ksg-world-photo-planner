import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/focus_stack/focus_pyramid_blend.dart';

/// Work354. Mirrors tool/raw_samples/test/focus_pyramid_blend_reference.test.mjs.

Float32List _frame(int w, int h, int seed, double offset) {
  final math.Random r = math.Random(seed);
  final Float32List rgb = Float32List(w * h * 3);
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      final double n = r.nextDouble();
      for (int c = 0; c < 3; c++) {
        rgb[(y * w + x) * 3 + c] =
            offset + 0.2 + 0.1 * c + 0.3 * n * (x > w / 2 ? 1 : 0.2);
      }
    }
  }
  return rgb;
}

Float32List _weights(int w, int h, int frames, int Function(int x, int y) winner) {
  final Float32List out = Float32List(w * h * frames);
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      out[(y * w + x) * frames + winner(x, y)] = 1;
    }
  }
  return out;
}

Float32List _crop(Float32List src, int srcW, int ch, int x0, int y0, int w, int h) {
  final Float32List out = Float32List(w * h * ch);
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      for (int c = 0; c < ch; c++) {
        out[(y * w + x) * ch + c] = src[((y + y0) * srcW + x + x0) * ch + c];
      }
    }
  }
  return out;
}

void main() {
  test('one-hot weights reproduce the chosen frame', () {
    const int w = 96, h = 80;
    final List<Float32List> frames = <Float32List>[
      _frame(w, h, 1, 0),
      _frame(w, h, 2, 0.05),
    ];
    final Float32List out = focusPyramidBlend(
      width: w,
      height: h,
      interleavedRgb: frames,
      interleavedWeights: _weights(w, h, 2, (int x, int y) => 1),
      levels: 4,
    );
    for (int i = 0; i < out.length; i++) {
      expect(out[i], closeTo(frames[1][i], 1e-5));
    }
  });

  test('tiled processing with aligned margins equals whole-image processing', () {
    const int imgW = 200, imgH = 150, levels = 3, tile = 64;
    final int margin = focusPyramidDependencyRadius(levels) + 8;
    final List<Float32List> frames = <Float32List>[
      _frame(imgW, imgH, 3, 0),
      _frame(imgW, imgH, 4, 0.1),
      _frame(imgW, imgH, 5, -0.05),
    ];
    final Float32List weights = _weights(
      imgW,
      imgH,
      3,
      (int x, int y) => (x + 2 * y) % 3 == 0 ? 0 : (x < 90 ? 1 : 2),
    );
    final Float32List whole = focusPyramidBlend(
      width: imgW,
      height: imgH,
      interleavedRgb: frames,
      interleavedWeights: weights,
      levels: levels,
    );
    for (int ty = 0; ty < imgH; ty += tile) {
      for (int tx = 0; tx < imgW; tx += tile) {
        final int tw = math.min(tile, imgW - tx);
        final int th = math.min(tile, imgH - ty);
        final ({int x, int y, int width, int height}) r = focusPyramidRegion(
          tileX: tx,
          tileY: ty,
          tileWidth: tw,
          tileHeight: th,
          imageWidth: imgW,
          imageHeight: imgH,
          levels: levels,
          margin: margin,
        );
        final Float32List out = focusPyramidBlend(
          width: r.width,
          height: r.height,
          interleavedRgb: <Float32List>[
            for (final Float32List f in frames)
              _crop(f, imgW, 3, r.x, r.y, r.width, r.height),
          ],
          interleavedWeights: _crop(weights, imgW, 3, r.x, r.y, r.width, r.height),
          levels: levels,
        );
        for (int y = 0; y < th; y++) {
          for (int x = 0; x < tw; x++) {
            for (int c = 0; c < 3; c++) {
              expect(
                out[((y + ty - r.y) * r.width + x + tx - r.x) * 3 + c],
                whole[((y + ty) * imgW + x + tx) * 3 + c],
              );
            }
          }
        }
      }
    }
  });

  test('a brightness step at a winner boundary becomes gradual', () {
    const int w = 128, h = 32;
    final Float32List a = Float32List(w * h * 3)..fillRange(0, w * h * 3, 0.40);
    final Float32List b = Float32List(w * h * 3)..fillRange(0, w * h * 3, 0.44);
    final Float32List out = focusPyramidBlend(
      width: w,
      height: h,
      interleavedRgb: <Float32List>[a, b],
      interleavedWeights: _weights(w, h, 2, (int x, int y) => x < 64 ? 0 : 1),
      levels: 4,
    );
    double maxStep = 0;
    for (int x = 1; x < w; x++) {
      final double step =
          (out[(16 * w + x) * 3 + 1] - out[(16 * w + x - 1) * 3 + 1]).abs();
      maxStep = math.max(maxStep, step);
    }
    expect(maxStep, lessThan(0.01));
  });

  test('tile region origin is aligned to the decimation grid', () {
    final ({int x, int y, int width, int height}) r = focusPyramidRegion(
      tileX: 768,
      tileY: 512,
      tileWidth: 256,
      tileHeight: 256,
      imageWidth: 6000,
      imageHeight: 4000,
    );
    expect(r.x % (1 << focusPyramidLevels), 0);
    expect(r.y % (1 << focusPyramidLevels), 0);
    expect(768 - r.x, greaterThanOrEqualTo(focusPyramidDependencyRadius(focusPyramidLevels)));
  });
}
