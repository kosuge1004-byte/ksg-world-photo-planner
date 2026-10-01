import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/meteor/streak_persistence_classifier.dart';
import 'package:mobile_stack/core/meteor/streak_shape.dart';
import 'package:mobile_stack/core/registration/similarity_transform_math.dart';

/// Dart port of `tool/raw_samples/test/streak_persistence_classifier_
/// reference.test.mjs`, including the two RANSAC/false-convergence-
/// adjacent regression tests from Work42 (sky-motion direction handling
/// for both neighbors, and skyMotion priority under mixed evidence).

final class _Streak implements StreakGeometry {
  _Streak(double x0, double y0, double x1, double y1)
      : endpoints = <({double x, double y})>[(x: x0, y: y0), (x: x1, y: y1)],
        angleRadians = math.atan2(y1 - y0, x1 - x0),
        centroidX = (x0 + x1) / 2,
        centroidY = (y0 + y1) / 2,
        width = 3;

  @override
  final List<({double x, double y})> endpoints;
  @override
  final double angleRadians;
  @override
  final double centroidX;
  @override
  final double centroidY;
  @override
  final double width;
}

final class _Transform implements SimilarityTransformEstimate {
  const _Transform(
    this.rotationDegrees,
    this.sourceOffsetX,
    this.sourceOffsetY,
    this.centerX,
    this.centerY,
  );

  @override
  final double rotationDegrees;
  @override
  final double sourceOffsetX;
  @override
  final double sourceOffsetY;
  @override
  final double centerX;
  @override
  final double centerY;
}

/// Builds a streak in the *next* frame that is exactly what [streak]
/// (in the current frame) would look like if it moved purely with the
/// sky transform: both endpoints (and therefore the centroid and
/// orientation) are mapped forward.
_Streak _propagateStreakWithSky(_Streak streak, _Transform transform) {
  final ({double x, double y}) a = streak.endpoints[0];
  final ({double x, double y}) b = streak.endpoints[1];
  final ({double x, double y}) mappedA =
      applySimilarityForward(transform, a.x, a.y);
  final ({double x, double y}) mappedB =
      applySimilarityForward(transform, b.x, b.y);
  return _Streak(mappedA.x, mappedA.y, mappedB.x, mappedB.y);
}

void main() {
  test('stellar association is independent of admissible candidate order', () {
    final source = _Streak(10, 10, 50, 10);
    final correct = _Streak(12, 10, 52, 10);
    final wrong = _Streak(20, 12, 60, 12);
    for (final candidates in [
      [wrong, correct],
      [correct, wrong]
    ]) {
      final results = classifyStreakPersistence([
        StreakFrame(frameIndex: 0, streaks: [source]),
        StreakFrame(frameIndex: 1, streaks: candidates),
      ], skyTransforms: [
        const _Transform(0, 2, 0, 0, 0)
      ]);
      expect(results.first.category, StreakPersistenceCategory.skyMotion);
      expect(results.first.independentMotionFrameIndices, isEmpty);
    }
  });
  test('rejects an empty frame list', () {
    expect(
      () => classifyStreakPersistence(<StreakFrame>[]),
      throwsA(isA<InvalidStreakLinkingInput>()),
    );
  });

  test('a single isolated streak in one frame is not persistent', () {
    final List<StreakFrame> frames = <StreakFrame>[
      StreakFrame(
        frameIndex: 0,
        streaks: <StreakGeometry>[_Streak(10, 10, 50, 10)],
      ),
    ];
    final List<StreakPersistenceResult> results =
        classifyStreakPersistence(frames);
    expect(results.length, 1);
    expect(results[0].persistentAcrossFrames, false);
    expect(results[0].linkedFrameIndices, isEmpty);
  });

  test(
    'a streak with no counterpart in the adjacent frames is not '
    'persistent (the classic single-frame meteor pattern)',
    () {
      final List<StreakFrame> frames = <StreakFrame>[
        const StreakFrame(frameIndex: 0, streaks: <StreakGeometry>[]),
        StreakFrame(
          frameIndex: 1,
          streaks: <StreakGeometry>[_Streak(10, 10, 60, 40)], // meteor
        ),
        const StreakFrame(frameIndex: 2, streaks: <StreakGeometry>[]),
      ];
      final List<StreakPersistenceResult> results =
          classifyStreakPersistence(frames);
      expect(results.length, 1);
      expect(results[0].frameIndex, 1);
      expect(results[0].persistentAcrossFrames, false);
    },
  );

  test(
    'a satellite-like streak continuing collinearly into the next frame '
    'is marked persistent',
    () {
      final List<StreakFrame> frames = <StreakFrame>[
        StreakFrame(
          frameIndex: 0,
          streaks: <StreakGeometry>[_Streak(10, 10, 50, 10)],
        ),
        // Continues the same horizontal line, picking up a short gap
        // away from where the previous segment ended.
        StreakFrame(
          frameIndex: 1,
          streaks: <StreakGeometry>[_Streak(55, 10, 95, 10)],
        ),
        StreakFrame(
          frameIndex: 2,
          streaks: <StreakGeometry>[_Streak(100, 10, 140, 10)],
        ),
      ];
      final List<StreakPersistenceResult> results =
          classifyStreakPersistence(frames);
      expect(results.length, 3);
      for (final StreakPersistenceResult result in results) {
        expect(
          result.persistentAcrossFrames,
          true,
          reason: 'frame ${result.frameIndex} should be linked',
        );
      }
      final StreakPersistenceResult middle =
          results.firstWhere((StreakPersistenceResult r) => r.frameIndex == 1);
      expect(middle.linkedFrameIndices..sort(), <int>[0, 2]);
      final StreakPersistenceResult first =
          results.firstWhere((StreakPersistenceResult r) => r.frameIndex == 0);
      expect(first.linkedFrameIndices, <int>[1]);
    },
  );

  test(
    'a large orientation mismatch is not linked, even if endpoints are '
    'close',
    () {
      final List<StreakFrame> frames = <StreakFrame>[
        StreakFrame(
          frameIndex: 0,
          streaks: <StreakGeometry>[_Streak(10, 10, 50, 10)], // horizontal
        ),
        StreakFrame(
          frameIndex: 1,
          streaks: <StreakGeometry>[_Streak(50, 10, 50, 50)], // vertical
        ),
      ];
      final List<StreakPersistenceResult> results = classifyStreakPersistence(
        frames,
        maxAngleDifferenceRadians: 10 * math.pi / 180,
      );
      for (final StreakPersistenceResult result in results) {
        expect(result.persistentAcrossFrames, false);
      }
    },
  );

  test(
    'a large positional gap is not linked, even with matching orientation',
    () {
      final List<StreakFrame> frames = <StreakFrame>[
        StreakFrame(
          frameIndex: 0,
          streaks: <StreakGeometry>[_Streak(10, 10, 50, 10)],
        ),
        StreakFrame(
          frameIndex: 1,
          // Same orientation, but far away.
          streaks: <StreakGeometry>[_Streak(500, 10, 540, 10)],
        ),
      ];
      final List<StreakPersistenceResult> results = classifyStreakPersistence(
        frames,
        maxEndpointGap: 40,
      );
      for (final StreakPersistenceResult result in results) {
        expect(result.persistentAcrossFrames, false);
      }
    },
  );

  test('non-adjacent (array-position) frames do not link to each other', () {
    // Frames 0 and 2 have matching collinear streaks, but frame 1 (with
    // an unrelated streak) sits between them in array order, so 0 and 2
    // are NOT each other's neighbors and must not be linked to one
    // another -- only to frame 1's candidates, which don't match.
    final List<StreakFrame> frames = <StreakFrame>[
      StreakFrame(
        frameIndex: 0,
        streaks: <StreakGeometry>[_Streak(10, 10, 50, 10)],
      ),
      StreakFrame(
        frameIndex: 1,
        streaks: <StreakGeometry>[_Streak(10, 80, 50, 95)], // unrelated
      ),
      StreakFrame(
        frameIndex: 2,
        streaks: <StreakGeometry>[_Streak(55, 10, 95, 10)],
      ),
    ];
    final List<StreakPersistenceResult> results =
        classifyStreakPersistence(frames);
    for (final StreakPersistenceResult result in results) {
      expect(
        result.persistentAcrossFrames,
        false,
        reason: 'frame ${result.frameIndex} should not be linked through '
            'a gap',
      );
    }
  });

  test(
    'an omitted (empty-streak) frame between two matching streaks still '
    'links them, since neighbors are by array position not frameIndex',
    () {
      // frameIndex jumps 0 -> 5 (frames 1-4 produced no candidates and
      // were omitted entirely, not passed as empty entries), but they
      // are still each other's array-position neighbors.
      final List<StreakFrame> frames = <StreakFrame>[
        StreakFrame(
          frameIndex: 0,
          streaks: <StreakGeometry>[_Streak(10, 10, 50, 10)],
        ),
        StreakFrame(
          frameIndex: 5,
          streaks: <StreakGeometry>[_Streak(55, 10, 95, 10)],
        ),
      ];
      final List<StreakPersistenceResult> results =
          classifyStreakPersistence(frames);
      for (final StreakPersistenceResult result in results) {
        expect(result.persistentAcrossFrames, true);
      }
    },
  );

  test('multiple candidates per frame are each evaluated independently', () {
    final List<StreakFrame> frames = <StreakFrame>[
      StreakFrame(
        frameIndex: 0,
        streaks: <StreakGeometry>[
          _Streak(10, 10, 50, 10), // links to frame 1's first streak
          _Streak(10, 100, 60, 130), // isolated (meteor-like)
        ],
      ),
      StreakFrame(
        frameIndex: 1,
        streaks: <StreakGeometry>[
          _Streak(55, 10, 95, 10),
          _Streak(200, 200, 240, 220), // unrelated to anything
        ],
      ),
    ];
    final List<StreakPersistenceResult> results =
        classifyStreakPersistence(frames);
    expect(results.length, 4);
    final int linkedCount = results
        .where((StreakPersistenceResult r) => r.persistentAcrossFrames)
        .length;
    expect(linkedCount, 2); // the one matching pair, both directions
  });

  test(
    'without skyTransforms, category falls back to isolated/'
    'linkedTransformUnavailable',
    () {
      final List<StreakFrame> frames = <StreakFrame>[
        StreakFrame(
          frameIndex: 0,
          streaks: <StreakGeometry>[_Streak(10, 10, 50, 10)],
        ),
        StreakFrame(
          frameIndex: 1,
          streaks: <StreakGeometry>[_Streak(55, 10, 95, 10)],
        ),
      ];
      final List<StreakPersistenceResult> results =
          classifyStreakPersistence(frames);
      for (final StreakPersistenceResult result in results) {
        expect(
          result.category,
          StreakPersistenceCategory.linkedTransformUnavailable,
        );
        expect(result.skyConsistentFrameIndices, isEmpty);
        expect(result.independentMotionFrameIndices, isEmpty);
      }
    },
  );

  test('rejects a skyTransforms array of the wrong length', () {
    final List<StreakFrame> frames = <StreakFrame>[
      const StreakFrame(frameIndex: 0, streaks: <StreakGeometry>[]),
      const StreakFrame(frameIndex: 1, streaks: <StreakGeometry>[]),
      const StreakFrame(frameIndex: 2, streaks: <StreakGeometry>[]),
    ];
    expect(
      () => classifyStreakPersistence(
        frames,
        skyTransforms: const <SimilarityTransformEstimate?>[null],
      ),
      throwsA(isA<InvalidStreakLinkingInput>()),
    );
  });

  test(
    'a streak whose next-frame position exactly matches the sky '
    'transform is classified skyMotion (a real star trail segment)',
    () {
      const _Transform transform = _Transform(2.5, 4, -3, 100, 100);
      final _Streak starStreak = _Streak(60, 40, 90, 55);
      final _Streak starStreakNext =
          _propagateStreakWithSky(starStreak, transform);
      final List<StreakFrame> frames = <StreakFrame>[
        StreakFrame(frameIndex: 0, streaks: <StreakGeometry>[starStreak]),
        StreakFrame(
          frameIndex: 1,
          streaks: <StreakGeometry>[starStreakNext],
        ),
      ];
      final List<StreakPersistenceResult> results = classifyStreakPersistence(
        frames,
        skyTransforms: <SimilarityTransformEstimate?>[transform],
      );
      for (final StreakPersistenceResult result in results) {
        expect(result.persistentAcrossFrames, true);
        expect(result.category, StreakPersistenceCategory.skyMotion);
        expect(result.independentMotionFrameIndices, isEmpty);
      }
      expect(results[0].skyConsistentFrameIndices, <int>[1]);
      expect(results[1].skyConsistentFrameIndices, <int>[0]);
    },
  );

  test(
    'a streak that is linked but moves independently of the sky '
    'transform is classified independentMotion (a satellite/aircraft '
    'candidate)',
    () {
      const _Transform transform = _Transform(2.5, 4, -3, 100, 100);
      // The star field rotates by ~2.5 degrees + a few px of drift, but
      // this streak instead just translates by a large, unrelated
      // amount -- consistent with an object crossing the frame under
      // its own motion, not tied to the sky's rotation.
      final _Streak satelliteStreak = _Streak(20, 150, 60, 165);
      final _Streak satelliteStreakNext = _Streak(55, 152, 95, 167);
      final List<StreakFrame> frames = <StreakFrame>[
        StreakFrame(
          frameIndex: 0,
          streaks: <StreakGeometry>[satelliteStreak],
        ),
        StreakFrame(
          frameIndex: 1,
          streaks: <StreakGeometry>[satelliteStreakNext],
        ),
      ];
      final List<StreakPersistenceResult> results = classifyStreakPersistence(
        frames,
        skyTransforms: <SimilarityTransformEstimate?>[transform],
      );
      for (final StreakPersistenceResult result in results) {
        expect(result.persistentAcrossFrames, true);
        expect(
          result.category,
          StreakPersistenceCategory.independentMotion,
        );
        expect(result.skyConsistentFrameIndices, isEmpty);
      }
    },
  );

  test(
    'a null entry in skyTransforms for a specific pair yields '
    'linkedTransformUnavailable for links through that pair',
    () {
      final List<StreakFrame> frames = <StreakFrame>[
        StreakFrame(
          frameIndex: 0,
          streaks: <StreakGeometry>[_Streak(10, 10, 50, 10)],
        ),
        StreakFrame(
          frameIndex: 1,
          streaks: <StreakGeometry>[_Streak(55, 10, 95, 10)],
        ),
      ];
      final List<StreakPersistenceResult> results = classifyStreakPersistence(
        frames,
        skyTransforms: const <SimilarityTransformEstimate?>[null],
      );
      for (final StreakPersistenceResult result in results) {
        expect(result.persistentAcrossFrames, true);
        expect(
          result.category,
          StreakPersistenceCategory.linkedTransformUnavailable,
        );
      }
    },
  );

  test(
    'sky-motion direction is handled correctly for both the previous '
    'and next neighbor (not just symmetrically by coincidence)',
    () {
      // Three frames with two DIFFERENT sky transforms, to catch a bug
      // where the "previous frame" direction accidentally reused the
      // "next frame" formula (or vice versa) without correctly
      // inverting it -- a symmetric single-transform test could pass by
      // coincidence even with such a bug. See WORK42_PROGRESS.md.
      const _Transform transformAB = _Transform(1.8, 3, -2, 120, 90);
      const _Transform transformBC = _Transform(3.1, -2, 4, 120, 90);
      final _Streak streakA = _Streak(30, 30, 70, 45);
      final _Streak streakB = _propagateStreakWithSky(streakA, transformAB);
      final _Streak streakC = _propagateStreakWithSky(streakB, transformBC);

      final List<StreakFrame> frames = <StreakFrame>[
        StreakFrame(frameIndex: 0, streaks: <StreakGeometry>[streakA]),
        StreakFrame(frameIndex: 1, streaks: <StreakGeometry>[streakB]),
        StreakFrame(frameIndex: 2, streaks: <StreakGeometry>[streakC]),
      ];
      final List<StreakPersistenceResult> results = classifyStreakPersistence(
        frames,
        skyTransforms: <SimilarityTransformEstimate?>[
          transformAB,
          transformBC,
        ],
      );
      for (final StreakPersistenceResult result in results) {
        expect(
          result.category,
          StreakPersistenceCategory.skyMotion,
          reason: 'frame ${result.frameIndex} should be skyMotion',
        );
      }
      final StreakPersistenceResult middle =
          results.firstWhere((StreakPersistenceResult r) => r.frameIndex == 1);
      expect(middle.skyConsistentFrameIndices..sort(), <int>[0, 2]);
    },
  );

  test(
    'skyMotion takes priority when one neighbor matches and the other '
    "doesn't (mixed evidence still favors the strong positive signal)",
    () {
      const _Transform transformAB = _Transform(2.0, 2, -1, 100, 100);
      final _Streak streakA = _Streak(40, 40, 70, 50);
      final _Streak streakB = _propagateStreakWithSky(streakA, transformAB);
      // Frame 2's streak is linked to frame 1's (similar orientation,
      // close enough endpoints) but was not generated via any sky
      // transform -- an unrelated coincidental near-match.
      final _Streak streakCUnrelated = _Streak(
        streakB.endpoints[0].x + 30,
        streakB.endpoints[0].y + 2,
        streakB.endpoints[1].x + 30,
        streakB.endpoints[1].y + 2,
      );

      final List<StreakFrame> frames = <StreakFrame>[
        StreakFrame(frameIndex: 0, streaks: <StreakGeometry>[streakA]),
        StreakFrame(frameIndex: 1, streaks: <StreakGeometry>[streakB]),
        StreakFrame(
          frameIndex: 2,
          streaks: <StreakGeometry>[streakCUnrelated],
        ),
      ];
      final List<StreakPersistenceResult> results = classifyStreakPersistence(
        frames,
        skyTransforms: <SimilarityTransformEstimate?>[transformAB, null],
      );
      final StreakPersistenceResult middle =
          results.firstWhere((StreakPersistenceResult r) => r.frameIndex == 1);
      expect(middle.category, StreakPersistenceCategory.skyMotion);
      expect(middle.skyConsistentFrameIndices, <int>[0]);
      expect(middle.independentMotionFrameIndices, isEmpty);
    },
  );
}
