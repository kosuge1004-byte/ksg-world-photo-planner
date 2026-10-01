import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/focus_stack/focus_aligned_frame.dart';
import 'package:mobile_stack/core/focus_stack/focus_blend_weights.dart';
import 'package:mobile_stack/core/focus_stack/focus_blender.dart';
import 'package:mobile_stack/core/focus_stack/focus_winner_map.dart';

void main() {
  FocusAlignedFrame frame(double value) => FocusAlignedFrame(
        width: 1,
        height: 1,
        interleavedRgb: Float32List.fromList(<double>[value, value, value]),
        coverage: Uint8List.fromList(<int>[1]),
      );

  test('high-confidence winner is copied exactly', () {
    final frames = <FocusAlignedFrame>[frame(.25), frame(.75)];
    final winners = FocusWinnerMap(
      width: 1,
      height: 1,
      frameIndices: Int32List.fromList(<int>[1]),
      confidence: Float32List.fromList(<double>[.95]),
    );
    final weights = buildFocusBlendWeights(frames: frames, winners: winners);
    final result = blendAlignedFocusFrames(frames: frames, weights: weights);
    expect(result.interleavedRgb[0], closeTo(.75, 1e-6));
  });

  test('memory-bounded blend is bit-exact with materialized weights', () {
    final List<FocusAlignedFrame> frames = <FocusAlignedFrame>[
      FocusAlignedFrame(
        width: 3,
        height: 1,
        interleavedRgb: Float32List.fromList(<double>[
          .2,
          .3,
          .4,
          .5,
          .6,
          .7,
          .8,
          .9,
          1,
        ]),
        coverage: Uint8List.fromList(<int>[1, 1, 0]),
      ),
      FocusAlignedFrame(
        width: 3,
        height: 1,
        interleavedRgb: Float32List.fromList(<double>[
          .7,
          .6,
          .5,
          .4,
          .3,
          .2,
          .1,
          .2,
          .3,
        ]),
        coverage: Uint8List.fromList(<int>[1, 1, 1]),
      ),
    ];
    final FocusWinnerMap winners = FocusWinnerMap(
      width: 3,
      height: 1,
      frameIndices: Int32List.fromList(<int>[0, 1, 0]),
      confidence: Float32List.fromList(<double>[.2, .8, .1]),
    );
    final FocusBlendResult expected = blendAlignedFocusFrames(
      frames: frames,
      weights: buildFocusBlendWeights(frames: frames, winners: winners),
    );
    final FocusBlendResult actual = blendAlignedFocusFramesMemoryBounded(
      frames: frames,
      winners: winners,
    );
    expect(actual.interleavedRgb, orderedEquals(expected.interleavedRgb));
    expect(actual.coverage, orderedEquals(expected.coverage));
  });

  test('memory-bounded blend reuses the reference tile buffers', () {
    final List<FocusAlignedFrame> frames = <FocusAlignedFrame>[
      frame(.25),
      frame(.75),
    ];
    final FocusWinnerMap winners = FocusWinnerMap(
      width: 1,
      height: 1,
      frameIndices: Int32List.fromList(<int>[1]),
      confidence: Float32List.fromList(<double>[.95]),
    );
    final FocusBlendResult result = blendAlignedFocusFramesMemoryBounded(
      frames: frames,
      winners: winners,
    );
    expect(identical(result.interleavedRgb, frames[0].interleavedRgb), isTrue);
    expect(identical(result.coverage, frames[0].coverage), isTrue);
    expect(result.interleavedRgb[0], closeTo(.75, 1e-6));
  });

  test('large RGB disagreement suppresses secondary contribution', () {
    final frames = <FocusAlignedFrame>[frame(.01), frame(1.0)];
    final winners = FocusWinnerMap(
      width: 1,
      height: 1,
      frameIndices: Int32List.fromList(<int>[1]),
      confidence: Float32List.fromList(<double>[.1]),
    );
    final weights = buildFocusBlendWeights(frames: frames, winners: winners);
    expect(weights.weightAt(0, 0, 0), lessThan(.2));
    expect(weights.weightAt(0, 0, 1), greaterThan(.8));
  });
}
