import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/engine/resource_snapshot.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/meteor/streak_persistence_classifier.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_decoder_registry.dart';
import 'package:mobile_stack/core/session/meteor_pipeline.dart';

import 'support/in_memory_rgb_tile_store.dart';

/// Tests [analyzeDecodedFrames] directly against hand-built fake tile
/// stores, containing synthetic rendered star fields and streaks (not
/// hand-built candidate lists) so the actual `detectStreakCandidates`,
/// `detectStars`, `estimateSimilarityTransform`, `classifyStreakPersistence`,
/// and `analyzeStreakBrightnessProfile` implementations all run end to
/// end together. See `meteor_pipeline.dart`'s own doc comment for why
/// [runMeteorAnalysisPipeline]'s `JobScheduler`-driven orchestration is
/// *not* covered here.

final class _PlaneBuilder {
  _PlaneBuilder(this.width, this.height, [double background = 0.15])
      : _rgb = Float32List(width * height * 3) {
    for (int pixel = 0; pixel < width * height; pixel++) {
      _rgb[pixel * 3] = background;
      _rgb[pixel * 3 + 1] = background;
      _rgb[pixel * 3 + 2] = background;
    }
  }

  final int width;
  final int height;
  final Float32List _rgb;

  void _addGreen(int x, int y, double value) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    _rgb[(y * width + x) * 3 + 1] += value;
  }

  void addGaussianStar(double cx, double cy, double peak, double sigma) {
    const int radius = 6;
    for (int dy = -radius; dy <= radius; dy++) {
      for (int dx = -radius; dx <= radius; dx++) {
        final int x = cx.round() + dx;
        final int y = cy.round() + dy;
        final double ox = x - cx;
        final double oy = y - cy;
        _addGreen(
          x,
          y,
          peak * math.exp(-(ox * ox + oy * oy) / (2 * sigma * sigma)),
        );
      }
    }
  }

  void addStreak(
    double x0,
    double y0,
    double x1,
    double y1,
    double peak,
    double crossSigma,
  ) {
    const double stepPx = 0.35;
    final double length = math.sqrt(
      math.pow(x1 - x0, 2) + math.pow(y1 - y0, 2),
    );
    final int steps = math.max(1, (length / stepPx).round());
    final int radius = (3 * crossSigma).ceil();
    for (int i = 0; i <= steps; i++) {
      final double t = i / steps;
      final double cx = x0 + (x1 - x0) * t;
      final double cy = y0 + (y1 - y0) * t;
      for (int dy = -radius; dy <= radius; dy++) {
        for (int dx = -radius; dx <= radius; dx++) {
          final int x = cx.round() + dx;
          final int y = cy.round() + dy;
          final double ox = x - cx;
          final double oy = y - cy;
          _addGreen(
            x,
            y,
            peak *
                math.exp(
                  -(ox * ox + oy * oy) / (2 * crossSigma * crossSigma),
                ) *
                (stepPx / crossSigma),
          );
        }
      }
    }
  }

  void addBeadedStreak(
    double x0,
    double y0,
    double x1,
    double y1,
    double peak,
    double crossSigma,
    int beadCount,
    double beadFraction,
  ) {
    for (int bead = 0; bead < beadCount; bead++) {
      final double segmentStart = bead / beadCount;
      final double segmentEnd = segmentStart + (beadFraction / beadCount);
      addStreak(
        x0 + (x1 - x0) * segmentStart,
        y0 + (y1 - y0) * segmentStart,
        x0 + (x1 - x0) * segmentEnd,
        y0 + (y1 - y0) * segmentEnd,
        peak,
        crossSigma,
      );
    }
  }

  InMemoryRgbTileStore build() => InMemoryRgbTileStore(
        width: width,
        height: height,
        interleavedRgb: _rgb,
      );
}

List<({double x, double y, double peak})> _seededStarField(
  int count,
  int seed,
  double width,
  double height,
  double margin,
) {
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  return <({double x, double y, double peak})>[
    for (int i = 0; i < count; i++)
      (
        x: margin + next() * (width - 2 * margin),
        y: margin + next() * (height - 2 * margin),
        peak: 3 + next() * 6,
      ),
  ];
}

({double x, double y}) _rotatePoint(
  double x,
  double y,
  double rotationDegrees,
  double centerX,
  double centerY,
  double dx,
  double dy,
) {
  final double radians = rotationDegrees * math.pi / 180;
  final double cosine = math.cos(radians);
  final double sine = math.sin(radians);
  final double ox = x - centerX;
  final double oy = y - centerY;
  return (
    x: centerX + cosine * ox - sine * oy + dx,
    y: centerY + sine * ox + cosine * oy + dy,
  );
}

void main() {
  test('restored frames keep original indices and skip RAW decode', () async {
    final first = _PlaneBuilder(120, 90);
    first.addStreak(15, 40, 100, 40, 5, 1.3);
    final second = _PlaneBuilder(120, 90);
    final stores = [first.build(), second.build()];
    final visited = <int>[];
    final result = await runMeteorAnalysisPipeline(
      sourcePaths: ['missing-first.arw', 'missing-second.arw'],
      decodingConfig:
          MeteorFrameDecodingConfig(decoderRegistry: RawDecoderRegistry([])),
      restoreDecodedFrame: (index) async {
        visited.add(index);
        return stores[index];
      },
      createFrameStore: (
          {required index,
          required width,
          required height,
          required plan}) async {
        throw StateError(
            'Restored frames must not create or decode RGB again.');
      },
      resourceReader: () async => const ResourceSnapshot(
          logicalProcessors: 1,
          availableMemoryBytes: 8 * 1024 * 1024 * 1024,
          thermalPressure: 0,
          batteryLevel: 1),
    );
    expect(visited, [0, 1]);
    expect(result.frameStores[0], same(stores[0]));
    expect(result.frameStores[1], same(stores[1]));
    expect(result.frameDiagnostics.every((d) => d.analyzed), isTrue);
    expect(result.candidates, hasLength(1));
    expect(result.candidates.single.frameIndex, 0);
  });

  test('孤立した(単一フレームの)流星痕候補はisolatedに分類される', () async {
    const int width = 150;
    const int height = 100;
    final _PlaneBuilder builder = _PlaneBuilder(width, height);
    builder.addStreak(20, 30, 100, 60, 5.0, 1.3);
    final InMemoryRgbTileStore store = builder.build();

    final MeteorAnalysisResult result = await analyzeDecodedFrames(
      sourcePaths: <String>['meteor.arw'],
      frameStores: <LinearRgbTileStore?>[store],
      decodeFailures: const <int, Object?>{},
    );

    expect(result.frameDiagnostics[0].analyzed, isTrue);
    expect(result.frameDiagnostics[0].detectedStreakCount, 1);
    expect(result.candidates, hasLength(1));
    final MeteorCandidate candidate = result.candidates.single;
    expect(
      candidate.persistence.category,
      StreakPersistenceCategory.isolated,
    );
    expect(candidate.brightnessProfile.likelyBlinking, isFalse);
  });

  test(
    '星の軌跡と同じ動きをする流星痕候補はskyMotionに分類される'
    '(実際の星検出→変換推定→分類の全パイプラインを通しで検証)',
    () async {
      const int width = 200;
      const int height = 160;
      const double centerX = width / 2;
      const double centerY = height / 2;
      const double trueRotation = 2.5;

      final List<({double x, double y, double peak})> starTruth =
          _seededStarField(22, 909, width.toDouble(), height.toDouble(), 20);
      const List<double> trailEndpoint0 = <double>[70, 60];
      const List<double> trailEndpoint1 = <double>[85, 68];

      InMemoryRgbTileStore renderFrame(int frameIndex) {
        final _PlaneBuilder builder = _PlaneBuilder(width, height);
        final double rotation = trueRotation * frameIndex;
        for (final star in starTruth) {
          final moved = _rotatePoint(
            star.x,
            star.y,
            rotation,
            centerX,
            centerY,
            0,
            0,
          );
          builder.addGaussianStar(moved.x, moved.y, star.peak, 1.3);
        }
        final movedA = _rotatePoint(
          trailEndpoint0[0],
          trailEndpoint0[1],
          rotation,
          centerX,
          centerY,
          0,
          0,
        );
        final movedB = _rotatePoint(
          trailEndpoint1[0],
          trailEndpoint1[1],
          rotation,
          centerX,
          centerY,
          0,
          0,
        );
        builder.addStreak(movedA.x, movedA.y, movedB.x, movedB.y, 4.0, 1.3);
        return builder.build();
      }

      final List<LinearRgbTileStore?> frameStores = <LinearRgbTileStore?>[
        renderFrame(0),
        renderFrame(1),
      ];

      final MeteorAnalysisResult result = await analyzeDecodedFrames(
        sourcePaths: <String>['a.arw', 'b.arw'],
        frameStores: frameStores,
        decodeFailures: const <int, Object?>{},
        skyMotionToleranceRadius: 10,
        maxEndpointGap: 60,
      );

      expect(result.frameDiagnostics[0].analyzed, isTrue);
      expect(result.frameDiagnostics[1].analyzed, isTrue);
      expect(result.candidates, isNotEmpty);
      final List<MeteorCandidate> renderedTrailCandidates =
          result.candidates.where((MeteorCandidate candidate) {
        final expected = _rotatePoint(
          77.5,
          64,
          trueRotation * candidate.frameIndex,
          centerX,
          centerY,
          0,
          0,
        );
        return math.sqrt(
              math.pow(candidate.persistence.streak.centroidX - expected.x, 2) +
                  math.pow(
                    candidate.persistence.streak.centroidY - expected.y,
                    2,
                  ),
            ) <
            5;
      }).toList();
      expect(renderedTrailCandidates, hasLength(2));
      for (final MeteorCandidate candidate in renderedTrailCandidates) {
        expect(
          candidate.persistence.category,
          StreakPersistenceCategory.skyMotion,
          reason: 'frame ${candidate.frameIndex} should be skyMotion',
        );
      }
    },
  );

  test('点滅する(ビーズ状の)流星痕候補はlikelyBlinking: trueと判定される', () async {
    const int width = 200;
    const int height = 100;
    final _PlaneBuilder builder = _PlaneBuilder(width, height);
    builder.addBeadedStreak(10, 50, 190, 50, 5.0, 1.3, 5, 0.3);
    final InMemoryRgbTileStore store = builder.build();

    final MeteorAnalysisResult result = await analyzeDecodedFrames(
      sourcePaths: <String>['plane.arw'],
      frameStores: <LinearRgbTileStore?>[store],
      decodeFailures: const <int, Object?>{},
    );

    expect(result.candidates, hasLength(1));
    expect(
      result.candidates.single.brightnessProfile.likelyBlinking,
      isTrue,
    );
  });

  test(
    'デコード失敗フレームは除外され診断に記録されるが、配列位置での隣接'
    '関係は正しくブリッジされる',
    () async {
      const int width = 150;
      const int height = 100;
      final _PlaneBuilder builderA = _PlaneBuilder(width, height);
      builderA.addStreak(20, 30, 100, 30, 5.0, 1.3);
      final _PlaneBuilder builderC = _PlaneBuilder(width, height);
      builderC.addStreak(20, 30, 100, 30, 5.0, 1.3);

      final MeteorAnalysisResult result = await analyzeDecodedFrames(
        sourcePaths: <String>['a.arw', 'broken.arw', 'c.arw'],
        frameStores: <LinearRgbTileStore?>[
          builderA.build(),
          null,
          builderC.build(),
        ],
        decodeFailures: <int, Object?>{1: StateError('decode broke')},
      );

      expect(result.frameDiagnostics[0].analyzed, isTrue);
      expect(result.frameDiagnostics[1].analyzed, isFalse);
      expect(
        result.frameDiagnostics[1].excludedReason,
        contains('decode failed'),
      );
      expect(result.frameDiagnostics[2].analyzed, isTrue);
      // frame 0 と frame 2 の流星痕は、配列上の隣接フレーム(gapを挟んで
      // も)として互いにリンクされ、persistentAcrossFrames になるはず。
      expect(
        result.candidates.every(
          (MeteorCandidate c) => c.persistence.persistentAcrossFrames,
        ),
        isTrue,
      );
    },
  );

  test('sourcePathsとframeStoresの長さが異なるとArgumentErrorを投げる', () async {
    expect(
      () => analyzeDecodedFrames(
        sourcePaths: <String>['a.arw'],
        frameStores: <LinearRgbTileStore?>[null, null],
        decodeFailures: const <int, Object?>{},
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test('全フレームがデコード失敗でも候補は空でエラーにならない', () async {
    final MeteorAnalysisResult result = await analyzeDecodedFrames(
      sourcePaths: <String>['a.arw', 'b.arw'],
      frameStores: <LinearRgbTileStore?>[null, null],
      decodeFailures: <int, Object?>{
        0: StateError('broken'),
        1: StateError('broken'),
      },
    );
    expect(result.candidates, isEmpty);
    expect(
      result.frameDiagnostics.every(
        (MeteorFrameDiagnostics d) => !d.analyzed,
      ),
      isTrue,
    );
  });

  test(
    'sourcePathsが空だとrunMeteorAnalysisPipelineはArgumentErrorを投げる',
    () async {
      final MeteorFrameDecodingConfig config = MeteorFrameDecodingConfig(
        decoderRegistry: RawDecoderRegistry(const <RawDecoder>[]),
      );
      expect(
        () => runMeteorAnalysisPipeline(
          sourcePaths: const <String>[],
          decodingConfig: config,
        ),
        throwsA(isA<ArgumentError>()),
      );
    },
  );

  test(
    'runMeteorAnalysisPipeline: masterDarkとdarkFramePathsを同時に指定'
    'するとArgumentErrorを投げる(Work110)',
    () async {
      final MeteorFrameDecodingConfig decodingConfig =
          MeteorFrameDecodingConfig(
        decoderRegistry: RawDecoderRegistry(const <RawDecoder>[]),
      );
      final LinearRawMosaic fakeMasterDark = LinearRawMosaic(
        width: 2,
        height: 2,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List(4),
      );
      await expectLater(
        runMeteorAnalysisPipeline(
          sourcePaths: const <String>['a.arw'],
          decodingConfig: decodingConfig,
          masterDark: fakeMasterDark,
          darkFramePaths: const <String>['dark0.arw'],
        ),
        throwsA(isA<ArgumentError>()),
      );
    },
  );

  test(
    'runMeteorAnalysisPipeline: masterFlatとflatFramePathsを同時に指定'
    'するとArgumentErrorを投げる(Work110)',
    () async {
      final MeteorFrameDecodingConfig decodingConfig =
          MeteorFrameDecodingConfig(
        decoderRegistry: RawDecoderRegistry(const <RawDecoder>[]),
      );
      final LinearRawMosaic fakeMasterFlat = LinearRawMosaic(
        width: 2,
        height: 2,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(<double>[1, 1, 1, 1]),
      );
      await expectLater(
        runMeteorAnalysisPipeline(
          sourcePaths: const <String>['a.arw'],
          decodingConfig: decodingConfig,
          masterFlat: fakeMasterFlat,
          flatFramePaths: const <String>['flat0.arw'],
        ),
        throwsA(isA<ArgumentError>()),
      );
    },
  );
}
