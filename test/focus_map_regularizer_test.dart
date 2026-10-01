import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/focus_stack/focus_map_regularizer.dart';
import 'package:mobile_stack/core/focus_stack/focus_winner_map.dart';

void main() {
  test('low-confidence isolated label follows strong local majority', () {
    final input = FocusWinnerMap(
      width: 3,
      height: 3,
      frameIndices: Int32List.fromList(<int>[
        2,
        2,
        2,
        2,
        0,
        2,
        2,
        2,
        2,
      ]),
      confidence: Float32List.fromList(<double>[
        .9,
        .9,
        .9,
        .9,
        .05,
        .9,
        .9,
        .9,
        .9,
      ]),
    );
    final output = regularizeFocusWinnerMap(
      input,
      radius: 1,
      minimumNeighborSupport: 0.1,
      maximumIterations: 1,
    );
    expect(output.frameIndices[4], 2);
  });

  test('high-confidence hard boundary remains unchanged', () {
    final input = FocusWinnerMap(
      width: 2,
      height: 1,
      frameIndices: Int32List.fromList(<int>[0, 4]),
      confidence: Float32List.fromList(<double>[.95, .95]),
    );
    final output = regularizeFocusWinnerMap(input);
    expect(output.frameIndices, orderedEquals(<int>[0, 4]));
  });

  test('regularization does not mutate its input buffers', () {
    final input = FocusWinnerMap(
      width: 3,
      height: 1,
      frameIndices: Int32List.fromList(<int>[1, 0, 1]),
      confidence: Float32List.fromList(<double>[.9, .05, .9]),
    );
    final Int32List originalFrameIndices =
        Int32List.fromList(input.frameIndices);
    final Float32List originalConfidence =
        Float32List.fromList(input.confidence);
    regularizeFocusWinnerMap(
      input,
      radius: 1,
      minimumNeighborSupport: 0.1,
      maximumIterations: 1,
    );
    expect(input.frameIndices, orderedEquals(originalFrameIndices));
    expect(input.confidence, orderedEquals(originalConfidence));
  });

  test('owned-buffer reuse is exact with the preserving path', () {
    FocusWinnerMap input() => FocusWinnerMap(
          width: 3,
          height: 3,
          frameIndices: Int32List.fromList(<int>[
            2,
            2,
            2,
            2,
            0,
            2,
            2,
            2,
            2,
          ]),
          confidence: Float32List.fromList(<double>[
            .9,
            .9,
            .9,
            .9,
            .05,
            .9,
            .9,
            .9,
            .9,
          ]),
        );
    final FocusWinnerMap expected = regularizeFocusWinnerMap(
      input(),
      radius: 1,
      minimumNeighborSupport: 0.1,
    );
    final FocusWinnerMap actual = regularizeFocusWinnerMap(
      input(),
      radius: 1,
      minimumNeighborSupport: 0.1,
      reuseInputBuffers: true,
    );
    expect(actual.frameIndices, orderedEquals(expected.frameIndices));
    expect(actual.confidence, orderedEquals(expected.confidence));
  });

  test('file-backed two-pass path is exact with in-memory two passes',
      () async {
    FocusWinnerMap input() => FocusWinnerMap(
          width: 5,
          height: 4,
          frameIndices: Int32List.fromList(<int>[
            0,
            0,
            1,
            1,
            2,
            0,
            2,
            1,
            2,
            2,
            0,
            0,
            1,
            2,
            2,
            0,
            1,
            1,
            2,
            2,
          ]),
          confidence: Float32List.fromList(<double>[
            .9,
            .8,
            .2,
            .8,
            .9,
            .8,
            .05,
            .2,
            .1,
            .8,
            .9,
            .7,
            .15,
            .2,
            .9,
            .8,
            .2,
            .7,
            .8,
            .9,
          ]),
        );
    final FocusWinnerMap expected = regularizeFocusWinnerMap(
      input(),
      radius: 1,
      minimumNeighborSupport: 0.1,
      maximumIterations: 2,
      reuseInputBuffers: true,
    );
    final FocusWinnerMap actual =
        await regularizeFocusWinnerMapFileBackedTwoPass(
      input(),
      radius: 1,
      minimumNeighborSupport: 0.1,
    );
    expect(actual.frameIndices, orderedEquals(expected.frameIndices));
    expect(actual.confidence, orderedEquals(expected.confidence));
  });
}
