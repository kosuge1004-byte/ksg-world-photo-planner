import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/focus_stack/focus_aligned_frame.dart';
import 'package:mobile_stack/core/focus_stack/focus_blender.dart';
import 'package:mobile_stack/core/focus_stack/focus_tiled_blender.dart';
import 'package:mobile_stack/core/focus_stack/focus_winner_map.dart';
import 'package:mobile_stack/core/registration/affine_sampling_transform.dart';
import 'package:mobile_stack/core/registration/tiled_affine_rgb_resampler.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

import 'support/in_memory_rgb_tile_store.dart';

void main() {
  test('tiled registered blend is bit-exact for identity-aligned frames',
      () async {
    const int width = 65;
    const int height = 41;
    final Float32List a = Float32List.fromList(<double>[
      for (int pixel = 0; pixel < width * height; pixel++)
        for (int channel = 0; channel < 3; channel++)
          ((pixel * 7 + channel * 11) % 97) / 97,
    ]);
    final Float32List b = Float32List.fromList(<double>[
      for (int pixel = 0; pixel < width * height; pixel++)
        for (int channel = 0; channel < 3; channel++)
          ((pixel * 13 + channel * 5) % 89) / 89,
    ]);
    final FocusWinnerMap winners = FocusWinnerMap(
      width: width,
      height: height,
      frameIndices: Int32List.fromList(<int>[
        for (int pixel = 0; pixel < width * height; pixel++) pixel & 1,
      ]),
      confidence: Float32List.fromList(<double>[
        for (int pixel = 0; pixel < width * height; pixel++)
          pixel % 3 == 0 ? .2 : .8,
      ]),
    );
    final FocusBlendResult expected = blendAlignedFocusFramesMemoryBounded(
      frames: <FocusAlignedFrame>[
        FocusAlignedFrame(
          width: width,
          height: height,
          interleavedRgb: Float32List.fromList(a),
          coverage: Uint8List(width * height)..fillRange(0, width * height, 1),
        ),
        FocusAlignedFrame(
          width: width,
          height: height,
          interleavedRgb: b,
          coverage: Uint8List(width * height)..fillRange(0, width * height, 1),
        ),
      ],
      winners: winners,
    );
    final InMemoryRgbTileStore storeA = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: a,
    );
    final InMemoryRgbTileStore storeB = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: b,
    );
    final FocusBlendResult actual =
        await blendRegisteredFocusStoresMemoryBounded(
      stores: <InMemoryRgbTileStore>[storeA, storeB],
      samplingTransforms: <AffineSamplingTransform>[
        AffineSamplingTransform.identity(),
        AffineSamplingTransform.identity(),
      ],
      winners: winners,
      tileSize: 32,
    );
    expect(actual.interleavedRgb, orderedEquals(expected.interleavedRgb));
    expect(actual.coverage, orderedEquals(expected.coverage));
    expect(storeA.readRequests.length, greaterThan(1));
    expect(storeB.readRequests.length, greaterThan(1));
  });

  test('tiled registered blend matches materialized transformed RGB', () async {
    const int width = 67;
    const int height = 43;
    final Float32List a = Float32List.fromList(<double>[
      for (int i = 0; i < width * height * 3; i++) ((i * 7) % 101) / 101,
    ]);
    final Float32List b = Float32List.fromList(<double>[
      for (int i = 0; i < width * height * 3; i++) ((i * 17) % 103) / 103,
    ]);
    final InMemoryRgbTileStore storeA = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: a,
    );
    final InMemoryRgbTileStore storeB = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: b,
    );
    final AffineSamplingTransform transform =
        AffineSamplingTransform.scaledSimilarity(
      scale: 1.004,
      rotationDegrees: .3,
      sourceOffsetX: .35,
      sourceOffsetY: -.2,
      centerX: (width - 1) * .5,
      centerY: (height - 1) * .5,
    );
    final FocusWinnerMap winners = FocusWinnerMap(
      width: width,
      height: height,
      frameIndices: Int32List.fromList(<int>[
        for (int i = 0; i < width * height; i++) i & 1,
      ]),
      confidence: Float32List.fromList(<double>[
        for (int i = 0; i < width * height; i++) i % 4 == 0 ? .15 : .75,
      ]),
    );
    final FocusAlignedFrame alignedB = await _materializeAligned(
      store: storeB,
      transform: transform,
      tileSize: 32,
    );
    final FocusBlendResult expected = blendAlignedFocusFramesMemoryBounded(
      frames: <FocusAlignedFrame>[
        FocusAlignedFrame(
          width: width,
          height: height,
          interleavedRgb: Float32List.fromList(a),
          coverage: Uint8List(width * height)..fillRange(0, width * height, 1),
        ),
        alignedB,
      ],
      winners: winners,
    );
    final FocusBlendResult actual =
        await blendRegisteredFocusStoresMemoryBounded(
      stores: <InMemoryRgbTileStore>[storeA, storeB],
      samplingTransforms: <AffineSamplingTransform>[
        AffineSamplingTransform.identity(),
        transform,
      ],
      winners: winners,
      tileSize: 32,
    );
    expect(actual.interleavedRgb, orderedEquals(expected.interleavedRgb));
    expect(actual.coverage, orderedEquals(expected.coverage));
  });
}

Future<FocusAlignedFrame> _materializeAligned({
  required InMemoryRgbTileStore store,
  required AffineSamplingTransform transform,
  required int tileSize,
}) async {
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: store.width,
    imageHeight: store.height,
    tileSize: tileSize,
    overlap: 0,
  );
  final TiledAffineRgbResampler resampler = TiledAffineRgbResampler(
    interpolation: ResamplingInterpolation.bicubic,
  );
  final Float32List rgb = Float32List(store.width * store.height * 3);
  final Uint8List coverage = Uint8List(store.width * store.height);
  for (final OverlappedTile tile in plan.tiles) {
    final CoveredLinearRgbTile sampled = await resampler.sampleTile(
      source: store,
      outputTile: tile,
      outputImageWidth: store.width,
      outputImageHeight: store.height,
      transform: transform,
    );
    for (int localY = 0; localY < tile.outputHeight; localY++) {
      final int globalPixel =
          (tile.outputY + localY) * store.width + tile.outputX;
      final int localPixel = localY * tile.outputWidth;
      rgb.setRange(
        globalPixel * 3,
        (globalPixel + tile.outputWidth) * 3,
        sampled.tile.interleavedRgb,
        localPixel * 3,
      );
      coverage.setRange(
        globalPixel,
        globalPixel + tile.outputWidth,
        sampled.coverage,
        localPixel,
      );
    }
  }
  return FocusAlignedFrame(
    width: store.width,
    height: store.height,
    interleavedRgb: rgb,
    coverage: coverage,
  );
}
