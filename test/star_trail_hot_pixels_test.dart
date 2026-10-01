import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/stacking/star_trail_hot_pixels.dart';

/// Work355. Mirrors tool/raw_samples/test/star_trail_hot_pixel_reference.test.mjs.

const int _w = 160;
const int _h = 120;
const List<(int, int, int)> _hot = <(int, int, int)>[
  (20, 30, 0),
  (100, 60, 2),
  (70, 90, 1),
  (140, 20, 0),
];

void _addHot(Float32List rgb, int x, int y, int c, double amp) {
  const List<List<double>> k = <List<double>>[
    <double>[0.12, 0.25, 0.12],
    <double>[0.25, 1, 0.25],
    <double>[0.12, 0.25, 0.12],
  ];
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      rgb[((y + dy) * _w + x + dx) * 3 + c] += amp * k[dy + 1][dx + 1];
    }
  }
}

void _addStar(Float32List rgb, double cx, double cy, double amp, double fwhm) {
  final double s = fwhm / 2.3548;
  for (int y = math.max(0, (cy - 6).floor()); y < math.min(_h, cy + 7); y++) {
    for (int x = math.max(0, (cx - 6).floor()); x < math.min(_w, cx + 7); x++) {
      final double v = amp *
          math.exp(-((x - cx) * (x - cx) + (y - cy) * (y - cy)) / (2 * s * s));
      for (int c = 0; c < 3; c++) {
        rgb[(y * _w + x) * 3 + c] += v;
      }
    }
  }
}

List<Float32List> _sequence(int frames) {
  final math.Random r = math.Random(1);
  final List<(double, double, double)> stars = <(double, double, double)>[
    for (int i = 0; i < 25; i++)
      (10 + r.nextDouble() * 140, 10 + r.nextDouble() * 100,
          0.05 + 0.3 * r.nextDouble()),
  ];
  return <Float32List>[
    for (int f = 0; f < frames; f++)
      () {
        final Float32List rgb = Float32List(_w * _h * 3);
        for (int i = 0; i < rgb.length; i++) {
          final double u = math.max(r.nextDouble(), 1e-12);
          rgb[i] = 0.02 +
              0.002 *
                  math.sqrt(-2 * math.log(u)) *
                  math.cos(2 * math.pi * r.nextDouble());
        }
        for (final (double, double, double) s in stars) {
          _addStar(rgb, s.$1 + 0.5 * f, s.$2 + 0.3 * f, s.$3, 2.4);
        }
        _addStar(rgb, 50 + 0.1 * f, 50, 0.6, 2.0);
        for (final (int, int, int) h in _hot) {
          _addHot(rgb, h.$1, h.$2, h.$3, 0.15);
        }
        return rgb;
      }(),
  ];
}

final class _MemoryStore implements LinearRgbTileStore {
  _MemoryStore(this.rgb);
  final Float32List rgb;
  @override
  int get width => _w;
  @override
  int get height => _h;
  @override
  int get persistentByteLength => rgb.lengthInBytes;
  @override
  int get completedTileCount => 1;
  @override
  bool get isCommitted => true;
  @override
  Future<LinearRgbTile> readRegion({
    required int x,
    required int y,
    required int width,
    required int height,
  }) async {
    final Float32List out = Float32List(width * height * 3);
    for (int row = 0; row < height; row++) {
      out.setRange(row * width * 3, (row + 1) * width * 3, rgb,
          ((row + y) * _w + x) * 3);
    }
    return LinearRgbTile(
        x: x, y: y, width: width, height: height, interleavedRgb: out);
  }

  @override
  Future<void> writeTile(LinearRgbTile tile) async {}
  @override
  Future<void> commit() async {}
  @override
  Future<void> abort() async {}
  @override
  Future<void> dispose() async {}
}

void main() {
  test('stationary hot pixels are found; moving and slow stars are not',
      () async {
    final List<Float32List> seq = _sequence(30);
    final List<Int32List> perFrame = <Int32List>[
      for (final Float32List rgb in seq)
        await detectStationaryPointCandidates(_MemoryStore(rgb),
            stripHeight: 37),
    ];
    final Int32List hot = buildStationaryHotPixelMap(perFrame);
    expect(hot.toList(),
        (<int>[for (final (int, int, int) h in _hot) h.$2 * _w + h.$1]..sort()));
  });

  test('short sequences never produce a hot map', () {
    expect(
      buildStationaryHotPixelMap(<Int32List>[
        for (int i = 0; i < 10; i++) Int32List.fromList(<int>[5, 6]),
      ]),
      isEmpty,
    );
  });

  test('corrected store is tile-invariant and removes hot pixels', () async {
    final Float32List frame = _sequence(1).single;
    final Int32List hot = Int32List.fromList(
        <int>[for (final (int, int, int) h in _hot) h.$2 * _w + h.$1]..sort());
    final HotPixelCorrectedRgbStore store =
        HotPixelCorrectedRgbStore(_MemoryStore(frame), hot);
    final LinearRgbTile whole =
        await store.readRegion(x: 0, y: 0, width: _w, height: _h);
    for (final (int, int, int) h in _hot) {
      expect(whole.interleavedRgb[(h.$2 * _w + h.$1) * 3 + h.$3],
          lessThan(0.05));
    }
    for (int ty = 0; ty < _h; ty += 32) {
      for (int tx = 0; tx < _w; tx += 32) {
        final int tw = math.min(32, _w - tx);
        final int th = math.min(32, _h - ty);
        final LinearRgbTile tile =
            await store.readRegion(x: tx, y: ty, width: tw, height: th);
        for (int y = 0; y < th; y++) {
          for (int x = 0; x < tw; x++) {
            for (int c = 0; c < 3; c++) {
              expect(tile.interleavedRgb[(y * tw + x) * 3 + c],
                  whole.interleavedRgb[((y + ty) * _w + x + tx) * 3 + c]);
            }
          }
        }
      }
    }
  });
}
