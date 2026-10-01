import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/meteor/streak_brightness_profile.dart';
import 'package:mobile_stack/core/meteor/streak_candidate_detector.dart';
import 'package:mobile_stack/core/meteor/streak_persistence_classifier.dart';
import 'package:mobile_stack/core/session/meteor_pipeline.dart';
import 'package:mobile_stack/features/meteor/meteor_review_screen.dart';

import 'support/in_memory_rgb_tile_store.dart';

StreakCandidate _geometry(double y) => StreakCandidate(
      centroidX: 4.5,
      centroidY: y,
      angleRadians: 0,
      length: 7,
      width: 2,
      elongation: 0.9,
      flux: 100,
      pixelCount: 14,
      endpoints: <({double x, double y})>[(x: 1, y: y), (x: 8, y: y)],
    );

const StreakBrightnessProfile _profile = StreakBrightnessProfile(
  profile: <double>[],
  positions: <({double x, double y})>[],
  segments: <BrightnessSegment>[],
  segmentCount: 0,
  likelyBlinking: false,
  longestGapFraction: 0,
  sufficientSamples: false,
);

MeteorCandidate _candidate(int frameIndex) => MeteorCandidate(
      persistence: StreakPersistenceResult(
        frameIndex: frameIndex,
        streak: _geometry(3 + frameIndex * 3),
        persistentAcrossFrames: false,
        linkedFrameIndices: const <int>[],
        skyConsistentFrameIndices: const <int>[],
        independentMotionFrameIndices: const <int>[],
        category: StreakPersistenceCategory.isolated,
      ),
      brightnessProfile: _profile,
    );

LinearRgbTileStore _frame() => InMemoryRgbTileStore(
      width: 10,
      height: 10,
      interleavedRgb: Float32List(10 * 10 * 3),
    );

void main() {
  testWidgets('複数候補を追加・解除し、選択件数を合成ボタンへ表示する', (
    WidgetTester tester,
  ) async {
    final MeteorAnalysisResult result = MeteorAnalysisResult(
      candidates: <MeteorCandidate>[_candidate(0), _candidate(1)],
      frameDiagnostics: const <MeteorFrameDiagnostics>[
        MeteorFrameDiagnostics(sourcePath: 'a.arw', analyzed: true),
        MeteorFrameDiagnostics(sourcePath: 'b.arw', analyzed: true),
      ],
      frameStores: <LinearRgbTileStore?>[_frame(), _frame()],
    );
    await tester.pumpWidget(
      MaterialApp(home: MeteorReviewScreen(result: result)),
    );
    expect(find.text('0件を合成する'), findsOneWidget);

    await tester.tap(find.text('フレーム 1'));
    await tester.pump();
    expect(find.text('1件を合成する'), findsOneWidget);

    await tester.tap(find.text('フレーム 2'));
    await tester.pump();
    expect(find.text('2件を合成する'), findsOneWidget);

    await tester.tap(find.text('フレーム 1'));
    await tester.pump();
    expect(find.text('1件を合成する'), findsOneWidget);
  });
}
