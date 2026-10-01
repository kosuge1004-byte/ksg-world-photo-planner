import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/star_detector.dart';
import 'package:mobile_stack/core/stacking/star_trail_gap_fill.dart';
import 'package:mobile_stack/core/stacking/star_trail_gap_fill_drawer.dart';

import 'support/in_memory_rgb_tile_store.dart';
import 'support/recording_rgb_tile_store.dart';

DetectedStar _star(double x, double y, double peak) => DetectedStar(
      x: x,
      y: y,
      flux: peak * 4,
      peakValue: peak,
      roundness: 0,
      sharpness: 0.5,
    );

void main() {
  test('gap keeps faded endpoint colour and marks only changed pixels',
      () async {
    const width = 12, height = 5;
    final rgb = Float32List(width * height * 3);
    rgb[(2 * width + 1) * 3] = .02;
    rgb[(2 * width + 1) * 3 + 2] = .01;
    rgb[(2 * width + 10) * 3] = .06;
    rgb[(2 * width + 10) * 3 + 2] = .03;
    final source =
        InMemoryRgbTileStore(width: width, height: height, interleavedRgb: rgb);
    final synthetic = Uint8List(width * height);
    final factory = RecordingRgbTileStoreFactory();
    final out = await createGapFilledStarTrailStore(
        source: source,
        outputStoreFactory: factory.call,
        segments: [
          const GapFillSegment(
              startX: 1.5, startY: 2.5, endX: 10.5, endY: 2.5, brightness: 1)
        ],
        tileSize: 4,
        onSyntheticMask: (x, y, w, h, mask) {
          for (int row = 0; row < h; row++) {
            synthetic.setRange((y + row) * width + x, (y + row) * width + x + w,
                mask, row * w);
          }
        });
    final actual =
        (await out.readRegion(x: 0, y: 0, width: width, height: height))
            .interleavedRgb;
    for (int i = 0; i < width * height; i++) {
      expect(actual[i * 3], lessThanOrEqualTo(.06000001));
      expect(actual[i * 3 + 1], 0);
      expect(actual[i * 3 + 2], closeTo(actual[i * 3] * .5, 1e-8));
      final changed =
          actual[i * 3] != rgb[i * 3] || actual[i * 3 + 2] != rgb[i * 3 + 2];
      expect(synthetic[i], changed ? 1 : 0);
    }
    expect(synthetic[2 * width + 6], 1);
    expect(synthetic[6], 0);
    await out.dispose();
  });

  test('off creates no segments and linear uses the fainter endpoint', () {
    final before = <DetectedStar>[
      _star(1, 2, 0.8),
      _star(30, 5, .7),
      _star(5, 40, .7),
      _star(100, 120, .8)
    ];
    final after = <DetectedStar>[
      _star(4, 2, 0.5),
      _star(33, 5, .7),
      _star(8, 40, .7),
      _star(103, 120, .8)
    ];
    expect(
      computeGapFillSegments(
        starsBefore: before,
        starsAfter: after,
        mode: StarTrailGapFillMode.off,
      ),
      isEmpty,
    );
    final linear = computeGapFillSegments(
      starsBefore: before,
      starsAfter: after,
      mode: StarTrailGapFillMode.linear,
    );
    expect(linear, hasLength(4));
    expect(linear.first.brightness, 0.5);
    expect(linear.first.samplePoints().last, (4.0, 2.0));
  });

  test('committed input is copied tile-by-tile and the gap is painted',
      () async {
    const int width = 8;
    const int height = 4;
    final source = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: Float32List(width * height * 3)
        ..[(1 * width + 1) * 3] = 1
        ..[(1 * width + 6) * 3] = 1,
    );
    final factory = RecordingRgbTileStoreFactory();
    final output = await createGapFilledStarTrailStore(
      source: source,
      outputStoreFactory: factory.call,
      segments: const <GapFillSegment>[
        GapFillSegment(
          startX: 1.5,
          startY: 1.5,
          endX: 6.5,
          endY: 1.5,
          brightness: 1,
        ),
      ],
      tileSize: 4,
    );
    expect(output.isCommitted, isTrue);
    expect(source.readRequests, hasLength(4));
    expect(source.readRequests.every((request) => request.width <= 4), isTrue);
    final painted = await output.readRegion(
      x: 0,
      y: 0,
      width: width,
      height: height,
    );
    expect(painted.interleavedRgb.any((value) => value > 0), isTrue);
    expect(painted.interleavedRgb[(1 * width + 1) * 3], greaterThan(0.9));
    expect(painted.interleavedRgb[(1 * width + 4) * 3], greaterThan(0));
    expect(painted.interleavedRgb[(1 * width + 4) * 3 + 1], 0);
    expect(painted.interleavedRgb[(1 * width + 4) * 3 + 2], 0);
  });

  test('cancellation aborts the partial output store', () async {
    final source = InMemoryRgbTileStore(
      width: 8,
      height: 8,
      interleavedRgb: Float32List(8 * 8 * 3),
    );
    final factory = RecordingRgbTileStoreFactory();
    await expectLater(
      createGapFilledStarTrailStore(
        source: source,
        outputStoreFactory: factory.call,
        segments: const <GapFillSegment>[],
        tileSize: 4,
        isCancelled: () => true,
      ),
      throwsStateError,
    );
    expect(factory.latest!.aborted, isTrue);
  });
}
