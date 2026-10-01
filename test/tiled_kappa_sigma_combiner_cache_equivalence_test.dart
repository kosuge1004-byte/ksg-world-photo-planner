// WORK350: the aligned-frame cache and the adaptive band size must never
// change a single output bit. Compares the historical Milky-Way configuration
// (cache disabled, 8192-pixel bands, every pass re-reads) against cached
// configurations across frame counts, including the <=7-frame robust seed.
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/registration/tiled_affine_rgb_resampler.dart';
import 'package:mobile_stack/core/stacking/tiled_kappa_sigma_combiner.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

const int _width = 64;
const int _height = 48;

OverlappedTile _tile() => const OverlappedTile(
      outputX: 0,
      outputY: 0,
      outputWidth: _width,
      outputHeight: _height,
      inputX: 0,
      inputY: 0,
      inputWidth: _width,
      inputHeight: _height,
    );

/// Noisy sky with satellite-like streaks, hot pixels and partial coverage.
({List<Float32List> rgb, List<Uint8List> coverage}) _fixture(
  int frames,
  int seed,
) {
  final math.Random random = math.Random(seed);
  final List<Float32List> rgb = <Float32List>[];
  final List<Uint8List> coverage = <Uint8List>[];
  for (int frame = 0; frame < frames; frame++) {
    final Float32List values = Float32List(_width * _height * 3);
    final Uint8List covered = Uint8List(_width * _height);
    for (int pixel = 0; pixel < _width * _height; pixel++) {
      final int x = pixel % _width;
      final int y = pixel ~/ _width;
      covered[pixel] = (x < frame % 5) ? 0 : 1; // edge coverage loss
      for (int channel = 0; channel < 3; channel++) {
        double value = 0.02 + 0.01 * channel + random.nextDouble() * 0.004;
        if (y == (frame * 7) % _height) value += 0.8; // streak
        if (random.nextInt(997) == 0) value += 5.0; // hot/cosmic
        values[pixel * 3 + channel] = value;
      }
    }
    rgb.add(values);
    coverage.add(covered);
  }
  return (rgb: rgb, coverage: coverage);
}

CoveredRgbRegionReader _reader(
  List<Float32List> frames,
  List<Uint8List> coverages,
  List<int> calls,
) {
  return (int frameIndex, OverlappedTile region) async {
    calls[0]++;
    final int pixels = region.outputWidth * region.outputHeight;
    final Float32List rgb = Float32List(pixels * 3); // fresh, like production
    final Uint8List coverage = Uint8List(pixels);
    for (int localY = 0; localY < region.outputHeight; localY++) {
      for (int localX = 0; localX < region.outputWidth; localX++) {
        final int source = (region.outputY + localY) * _width + region.outputX + localX;
        final int destination = localY * region.outputWidth + localX;
        rgb.setRange(destination * 3, destination * 3 + 3, frames[frameIndex], source * 3);
        coverage[destination] = coverages[frameIndex][source];
      }
    }
    return CoveredLinearRgbTile(
      tile: LinearRgbTile(
        x: region.outputX,
        y: region.outputY,
        width: region.outputWidth,
        height: region.outputHeight,
        interleavedRgb: rgb,
      ),
      coverage: coverage,
    );
  };
}

Future<(RejectionStackedRgbTile, int)> _run(
  TiledKappaSigmaCombiner combiner,
  ({List<Float32List> rgb, List<Uint8List> coverage}) fixture,
) async {
  final List<int> calls = <int>[0];
  final int frames = fixture.rgb.length;
  final RejectionStackedRgbTile result = await combiner.combineTile(
    frameCount: frames,
    frameWeights: <double>[for (int i = 0; i < frames; i++) 0.55 + (i % 9) * 0.05],
    outputTile: _tile(),
    readFrame: _reader(fixture.rgb, fixture.coverage, calls),
  );
  return (result, calls[0]);
}

TiledKappaSigmaCombiner _combiner({
  required int bandPixels,
  required int cacheBytes,
}) =>
    TiledKappaSigmaCombiner(
      minimumSurvivingFrames: 2,
      robustSmallStackInitialization: true,
      synchronizeRgbRejection: true,
      maximumPixelsPerBand: bandPixels,
      maximumAlignedFrameCacheBytes: cacheBytes,
    );

void _expectBitIdentical(RejectionStackedRgbTile a, RejectionStackedRgbTile b) {
  expect(
    Uint8List.view(b.tile.interleavedRgb.buffer, b.tile.interleavedRgb.offsetInBytes,
        b.tile.interleavedRgb.lengthInBytes),
    orderedEquals(Uint8List.view(a.tile.interleavedRgb.buffer,
        a.tile.interleavedRgb.offsetInBytes, a.tile.interleavedRgb.lengthInBytes)),
  );
  expect(b.contributingSamples, orderedEquals(a.contributingSamples));
}

void main() {
  for (final int frames in <int>[3, 5, 7, 12, 50]) {
    test('cache and adaptive band are bit-identical ($frames frames)', () async {
      final fixture = _fixture(frames, 350 + frames);
      final (RejectionStackedRgbTile reference, int referenceCalls) = await _run(
        _combiner(bandPixels: 8192, cacheBytes: 0), // pre-WORK350 Milky Way
        fixture,
      );
      for (final (int band, int cache) in <(int, int)>[
        (8192, 32 * 1024 * 1024), // WORK350 Milky Way
        (65536, 32 * 1024 * 1024), // meteor defaults
        (_width, 32 * 1024 * 1024), // one-row bands
        (65536, frames * _width * 13 * 3), // forces adaptive shrink to 3 rows
      ]) {
        final (RejectionStackedRgbTile cached, int cachedCalls) =
            await _run(_combiner(bandPixels: band, cacheBytes: cache), fixture);
        _expectBitIdentical(reference, cached);
        final int bandPixels = _combiner(bandPixels: band, cacheBytes: cache)
            .effectiveBandPixels(frameCount: frames, tileWidth: _width);
        final int bands = (_height / math.max(1, bandPixels ~/ _width)).ceil();
        expect(cachedCalls, frames * bands, reason: 'one read per frame and band');
      }
      expect(referenceCalls, greaterThan(frames)); // re-read path really re-reads
    });
  }

  test('adaptive band keeps 300 frames of a 128px tile inside 32 MiB', () {
    final TiledKappaSigmaCombiner combiner = _combiner(
      bandPixels: 8192,
      cacheBytes: 32 * 1024 * 1024,
    );
    final int pixels = combiner.effectiveBandPixels(frameCount: 300, tileWidth: 128);
    expect(pixels, greaterThanOrEqualTo(128));
    expect(pixels * 300 * 13, lessThanOrEqualTo(32 * 1024 * 1024));
  });

  test('falls back to re-read path when one row cannot be cached', () {
    final TiledKappaSigmaCombiner combiner = _combiner(bandPixels: 8192, cacheBytes: 1024);
    expect(combiner.effectiveBandPixels(frameCount: 50, tileWidth: 128), 8192);
  });
}
