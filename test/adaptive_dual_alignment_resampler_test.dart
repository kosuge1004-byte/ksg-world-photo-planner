import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/adaptive_dual_alignment_resampler.dart';
import 'package:mobile_stack/core/registration/affine_sampling_transform.dart';
import 'package:mobile_stack/core/registration/tiled_affine_rgb_resampler.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

import 'support/in_memory_rgb_tile_store.dart';

Float32List _scene({required bool target}) {
  const int width = 5;
  const int height = 5;
  final Float32List rgb = Float32List(width * height * 3);
  void setPixel(int x, int y, double value) {
    final int base = (y * width + x) * 3;
    rgb[base] = value;
    rgb[base + 1] = value;
    rgb[base + 2] = value;
  }

  // The point source moves one pixel between exposures.
  setPixel(target ? 3 : 2, 1, 1);
  // The foreground remains fixed on the tripod.
  setPixel(1, 3, 1);
  setPixel(2, 3, 0.8);
  return rgb;
}

void main() {
  test('aligns moving stars while preserving a static foreground', () async {
    final InMemoryRgbTileStore reference = InMemoryRgbTileStore(
      width: 5,
      height: 5,
      interleavedRgb: _scene(target: false),
    );
    final InMemoryRgbTileStore target = InMemoryRgbTileStore(
      width: 5,
      height: 5,
      interleavedRgb: _scene(target: true),
    );
    final AdaptiveDualAlignmentResampler selector =
        AdaptiveDualAlignmentResampler(
      starResampler: TiledAffineRgbResampler(),
    );
    final result = await selector.sampleTile(
      reference: reference,
      source: target,
      outputTile: const OverlappedTile(
        outputX: 0,
        outputY: 0,
        outputWidth: 4,
        outputHeight: 5,
        inputX: 0,
        inputY: 0,
        inputWidth: 4,
        inputHeight: 5,
      ),
      outputImageWidth: 5,
      outputImageHeight: 5,
      starTransform: AffineSamplingTransform.similarity(
        rotationDegrees: 0,
        sourceOffsetX: 1,
        sourceOffsetY: 0,
        centerX: 2,
        centerY: 2,
      ),
    );

    for (int y = 0; y < 5; y++) {
      for (int x = 0; x < 4; x++) {
        final double expected = _scene(target: false)[(y * 5 + x) * 3];
        expect(result.tile.channelAt(x, y, 0), closeTo(expected, 1e-6));
      }
    }
    expect(result.coverage, everyElement(1));
  });
  test('release時も不正なdual-alignment閾値を拒否する', () async {
    const AdaptiveDualAlignmentResampler selector =
        AdaptiveDualAlignmentResampler(
      starResampler: TiledAffineRgbResampler(),
      identityAdvantageRatio: double.nan,
    );
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: 1,
      height: 1,
      interleavedRgb: Float32List.fromList(<double>[1, 1, 1]),
    );
    expect(
      () => selector.sampleTile(
        reference: store,
        source: store,
        outputTile: const OverlappedTile(
          outputX: 0,
          outputY: 0,
          outputWidth: 1,
          outputHeight: 1,
          inputX: 0,
          inputY: 0,
          inputWidth: 1,
          inputHeight: 1,
        ),
        outputImageWidth: 1,
        outputImageHeight: 1,
        starTransform: AffineSamplingTransform.identity(),
      ),
      throwsA(isA<ArgumentError>()),
    );
  });
  test(
    'stellar transform outside source stays uncovered instead of using unaligned identity sky',
    () async {
      final Float32List referenceRgb = Float32List(5 * 3);
      final Float32List sourceRgb = Float32List(5 * 3);
      // Put a bright source point at x=0.  A +1 source offset means output
      // x=4 maps to source x=5 (outside).  The old dual-alignment fallback
      // incorrectly copied source x=4 by identity and marked it covered.
      sourceRgb[4 * 3] = 1;
      sourceRgb[4 * 3 + 1] = 1;
      sourceRgb[4 * 3 + 2] = 1;
      final InMemoryRgbTileStore reference = InMemoryRgbTileStore(
        width: 5,
        height: 1,
        interleavedRgb: referenceRgb,
      );
      final InMemoryRgbTileStore source = InMemoryRgbTileStore(
        width: 5,
        height: 1,
        interleavedRgb: sourceRgb,
      );
      final AdaptiveDualAlignmentResampler selector =
          AdaptiveDualAlignmentResampler(
        starResampler: TiledAffineRgbResampler(),
      );

      final result = await selector.sampleTile(
        reference: reference,
        source: source,
        outputTile: const OverlappedTile(
          outputX: 0,
          outputY: 0,
          outputWidth: 5,
          outputHeight: 1,
          inputX: 0,
          inputY: 0,
          inputWidth: 5,
          inputHeight: 1,
        ),
        outputImageWidth: 5,
        outputImageHeight: 1,
        starTransform: AffineSamplingTransform.similarity(
          rotationDegrees: 0,
          sourceOffsetX: 1,
          sourceOffsetY: 0,
          centerX: 2,
          centerY: 0,
        ),
      );

      expect(result.coverage[4], 0);
      expect(result.tile.channelAt(4, 0, 0), 0);
      expect(result.tile.channelAt(4, 0, 1), 0);
      expect(result.tile.channelAt(4, 0, 2), 0);
    },
  );
  test('isolated one-pixel identity decision is suppressed', () async {
    const int width = 5;
    const int height = 5;
    final Float32List referenceRgb = Float32List(width * height * 3);
    final Float32List sourceRgb = Float32List(width * height * 3);
    void setPixel(Float32List rgb, int x, int y, double value) {
      final int base = (y * width + x) * 3;
      rgb[base] = value;
      rgb[base + 1] = value;
      rgb[base + 2] = value;
    }

    // One tripod-fixed bright pixel. With the +1 stellar source offset,
    // stellar sampling at (1,3) reads source (2,3)=0, so the raw per-pixel
    // selector would prefer identity there. WORK346 must suppress this
    // singleton because no adjacent pixel supports the identity domain.
    setPixel(referenceRgb, 1, 3, 1);
    setPixel(sourceRgb, 1, 3, 1);
    final InMemoryRgbTileStore reference = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: referenceRgb,
    );
    final InMemoryRgbTileStore source = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: sourceRgb,
    );
    final AdaptiveDualAlignmentResampler selector =
        AdaptiveDualAlignmentResampler(
      starResampler: TiledAffineRgbResampler(),
    );
    final result = await selector.sampleTile(
      reference: reference,
      source: source,
      outputTile: const OverlappedTile(
        outputX: 0,
        outputY: 0,
        outputWidth: width,
        outputHeight: height,
        inputX: 0,
        inputY: 0,
        inputWidth: width,
        inputHeight: height,
      ),
      outputImageWidth: width,
      outputImageHeight: height,
      starTransform: AffineSamplingTransform.similarity(
        rotationDegrees: 0,
        sourceOffsetX: 1,
        sourceOffsetY: 0,
        centerX: 2,
        centerY: 2,
      ),
    );

    expect(result.tile.channelAt(1, 3, 0), closeTo(0, 1e-6));
  });

  test(
      'spatial identity support sees a neighbour across the requested tile edge',
      () async {
    const int width = 5;
    const int height = 3;
    final Float32List referenceRgb = Float32List(width * height * 3);
    final Float32List sourceRgb = Float32List(width * height * 3);
    void setPixel(Float32List rgb, int x, int y, double value) {
      final int base = (y * width + x) * 3;
      rgb[base] = value;
      rgb[base + 1] = value;
      rgb[base + 2] = value;
    }

    // Two connected foreground pixels straddle the right boundary of the
    // requested region (x=1 inside, x=2 outside). The one-pixel halo must
    // allow x=1 to see x=2 and retain the identity sample.
    setPixel(referenceRgb, 1, 1, 1);
    setPixel(referenceRgb, 2, 1, 1);
    setPixel(sourceRgb, 1, 1, 1);
    setPixel(sourceRgb, 2, 1, 1);
    final InMemoryRgbTileStore reference = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: referenceRgb,
    );
    final InMemoryRgbTileStore source = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: sourceRgb,
    );
    final AdaptiveDualAlignmentResampler selector =
        AdaptiveDualAlignmentResampler(
      starResampler: TiledAffineRgbResampler(),
    );
    final result = await selector.sampleTile(
      reference: reference,
      source: source,
      outputTile: const OverlappedTile(
        outputX: 0,
        outputY: 0,
        outputWidth: 2,
        outputHeight: height,
        inputX: 0,
        inputY: 0,
        inputWidth: 2,
        inputHeight: height,
      ),
      outputImageWidth: width,
      outputImageHeight: height,
      starTransform: AffineSamplingTransform.similarity(
        rotationDegrees: 0,
        sourceOffsetX: 1,
        sourceOffsetY: 0,
        centerX: 2,
        centerY: 1,
      ),
    );

    expect(result.tile.channelAt(1, 1, 0), closeTo(1, 1e-6));
  });

  test(
      'two-hop foreground support is invariant across one-pixel tile boundaries',
      () async {
    final reference = InMemoryRgbTileStore(
        width: 5, height: 5, interleavedRgb: _scene(target: false));
    final source = InMemoryRgbTileStore(
        width: 5, height: 5, interleavedRgb: _scene(target: true));
    final selector = AdaptiveDualAlignmentResampler(
        starResampler: TiledAffineRgbResampler());
    final transform = AffineSamplingTransform.similarity(
        rotationDegrees: 0,
        sourceOffsetX: 1,
        sourceOffsetY: 0,
        centerX: 2,
        centerY: 2);
    OverlappedTile tile(int x, int width) => OverlappedTile(
        outputX: x,
        outputY: 0,
        outputWidth: width,
        outputHeight: 5,
        inputX: x,
        inputY: 0,
        inputWidth: width,
        inputHeight: 5);
    final whole = await selector.sampleTile(
        reference: reference,
        source: source,
        outputTile: tile(0, 5),
        outputImageWidth: 5,
        outputImageHeight: 5,
        starTransform: transform);
    for (int x = 0; x < 5; x++) {
      final part = await selector.sampleTile(
          reference: reference,
          source: source,
          outputTile: tile(x, 1),
          outputImageWidth: 5,
          outputImageHeight: 5,
          starTransform: transform);
      for (int y = 0; y < 5; y++) {
        expect(part.coverage[y], whole.coverage[y * 5 + x]);
        for (int c = 0; c < 3; c++) {
          expect(part.tile.channelAt(0, y, c), whole.tile.channelAt(x, y, c),
              reason: 'tile x=$x y=$y channel=$c');
        }
      }
    }
    expect(whole.tile.channelAt(0, 3, 0), 0);
    expect(whole.tile.channelAt(1, 3, 0), 1);
    expect(whole.tile.channelAt(2, 3, 0), closeTo(.8, 1e-6));
  });
}
