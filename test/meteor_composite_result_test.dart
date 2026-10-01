import 'dart:io';
import 'dart:typed_data';
import 'package:mobile_stack/core/registration/affine_sampling_transform.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/dng_final_render_profile.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/meteor/meteor_composite_result.dart';
import 'package:mobile_stack/core/meteor/streak_brightness_profile.dart';
import 'package:mobile_stack/core/meteor/streak_persistence_classifier.dart';
import 'package:mobile_stack/core/meteor/streak_shape.dart';
import 'package:mobile_stack/core/session/meteor_pipeline.dart';
import 'package:mobile_stack/core/stacking/tiled_kappa_sigma_combiner.dart';

import 'support/in_memory_rgb_tile_store.dart';
import 'support/recording_rgb_tile_store.dart';

DngFinalRenderProfile _meteorRenderProfile(double ev) =>
    DngFinalRenderProfile.fromMetadata(
      sourceId: 'meteor-reference.dng',
      metadata: RawFrameMetadata(
        format: RawFormat.dng,
        activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
        orientation: 1,
        blackLevels: const <double>[0, 0, 0, 0],
        whiteLevel: 1,
        baselineExposure: ev,
      ),
      cfaPattern: CfaPattern.rggb,
    );

final class _FakeStreakGeometry implements StreakGeometry {
  const _FakeStreakGeometry();

  @override
  List<({double x, double y})> get endpoints =>
      const <({double x, double y})>[(x: 0, y: 0), (x: 1, y: 1)];
  @override
  double get width => 2;
  @override
  double get centroidX => 0.5;
  @override
  double get centroidY => 0.5;
  @override
  double get angleRadians => 0;
}

const StreakBrightnessProfile _fakeBrightnessProfile = StreakBrightnessProfile(
  profile: <double>[],
  positions: <({double x, double y})>[],
  segments: <BrightnessSegment>[],
  segmentCount: 0,
  likelyBlinking: false,
  longestGapFraction: 0,
  sufficientSamples: false,
);

MeteorCandidate _fakeCandidateAt(int frameIndex) => MeteorCandidate(
      persistence: StreakPersistenceResult(
        frameIndex: frameIndex,
        streak: const _FakeStreakGeometry(),
        persistentAcrossFrames: false,
        linkedFrameIndices: const <int>[],
        skyConsistentFrameIndices: const <int>[],
        independentMotionFrameIndices: const <int>[],
        category: StreakPersistenceCategory.isolated,
      ),
      brightnessProfile: _fakeBrightnessProfile,
    );

MeteorAnalysisResult _fakeResult({
  required List<bool> analyzedFlags,
  List<int> candidateFrameIndices = const <int>[],
}) {
  return MeteorAnalysisResult(
    candidates: <MeteorCandidate>[
      for (final int index in candidateFrameIndices) _fakeCandidateAt(index),
    ],
    frameDiagnostics: <MeteorFrameDiagnostics>[
      for (int index = 0; index < analyzedFlags.length; index++)
        MeteorFrameDiagnostics(
          sourcePath: 'frame$index.arw',
          analyzed: analyzedFlags[index],
        ),
    ],
    frameStores: List<LinearRgbTileStore?>.filled(
      analyzedFlags.length,
      null,
    ),
  );
}

/// Tests [compositeSelectedMeteorCandidateAndExport] end to end against
/// fake tile stores and a real temp-directory file. The pieces it wires
/// together (`compositeSelectedStreaks`, `exportLinearRgbTileToBmp`)
/// already have their own dedicated test coverage
/// (`streak_compositor_test.dart`, `export_result_test.dart`); this
/// file's job is specifically the new orchestration logic (reading the
/// right two frames by index, rejecting an undecoded/null store or an
/// out-of-range index, and the export actually happening).

final class _Streak implements StreakShape {
  _Streak(double x0, double y0, double x1, double y1, [double streakWidth = 2])
      : endpoints = <({double x, double y})>[(x: x0, y: y0), (x: x1, y: y1)],
        width = streakWidth;

  @override
  final List<({double x, double y})> endpoints;
  @override
  final double width;
}

InMemoryRgbTileStore _constantFrame(
  int width,
  int height,
  double red,
  double green,
  double blue,
) {
  final Float32List rgb = Float32List(width * height * 3);
  for (int pixel = 0; pixel < width * height; pixel++) {
    rgb[pixel * 3] = red;
    rgb[pixel * 3 + 1] = green;
    rgb[pixel * 3 + 2] = blue;
  }
  return InMemoryRgbTileStore(
    width: width,
    height: height,
    interleavedRgb: rgb,
  );
}

void main() {
  test('tiled meteor moves RGB and streak mask into the reference grid',
      () async {
    const width = 24, height = 16;
    final foreground = Float32List(width * height * 3);
    for (int x = 10; x <= 14; x++) {
      foreground[(8 * width + x) * 3] = 1;
    }
    final dir = await Directory.systemTemp.createTemp('meteor-transform-');
    try {
      final factory = RecordingRgbTileStoreFactory();
      await compositeSelectedMeteorStreaksTiledAndExport(
        frameStores: [
          _constantFrame(width, height, .1, .1, .1),
          InMemoryRgbTileStore(
              width: width, height: height, interleavedRgb: foreground)
        ],
        frameTransforms: {
          0: AffineSamplingTransform.identity(),
          1: AffineSamplingTransform.similarity(
              rotationDegrees: 0,
              sourceOffsetX: 4,
              sourceOffsetY: 2,
              centerX: 0,
              centerY: 0)
        },
        selectedStreaks: [
          SelectedMeteorStreak(frameIndex: 1, streak: _Streak(10, 8, 14, 8, .8))
        ],
        backgroundFrameIndices: [0],
        intermediateTileStoreFactory: factory.call,
        exportPath: '${dir.path}/registered.bmp',
        paddingPixels: 0,
        exposureScale: 1,
        whitePoint: 1,
      );
      final rgb = factory.created[1].writtenTiles.single.interleavedRgb;
      expect(rgb[(6 * width + 8) * 3], closeTo(1, 1e-6));
      // Meteor compositing keeps the existing per-channel max contract.
      expect(rgb[(6 * width + 8) * 3 + 1], closeTo(.1, 1e-6));
      expect(rgb[(8 * width + 12) * 3], closeTo(.1, 1e-6));
      expect(rgb[(5 * width + 8) * 3], closeTo(.1, 1e-6));
    } finally {
      await dir.delete(recursive: true);
    }
  });

  test('tiled meteor export carries the reference render profile', () async {
    const int width = 8;
    const int height = 8;
    final List<LinearRgbTileStore?> stores = <LinearRgbTileStore?>[
      _constantFrame(width, height, 0.1, 0.1, 0.1),
      _constantFrame(width, height, 0.1, 0.1, 0.1),
    ];
    final Directory temp = await Directory.systemTemp.createTemp(
      'mobile-stack-meteor-render-profile-',
    );
    try {
      final RecordingRgbTileStoreFactory baseFactory =
          RecordingRgbTileStoreFactory();
      final File baseline = await compositeSelectedMeteorStreaksTiledAndExport(
        frameTransforms: {
          for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
        },
        frameStores: stores,
        selectedStreaks: <SelectedMeteorStreak>[
          SelectedMeteorStreak(frameIndex: 1, streak: _Streak(1, 4, 6, 4, 1)),
        ],
        backgroundFrameIndices: <int>[0],
        intermediateTileStoreFactory: baseFactory.call,
        exportPath: '${temp.path}${Platform.pathSeparator}baseline.bmp',
        exposureScale: 1,
        whitePoint: 1,
      );
      final RecordingRgbTileStoreFactory profiledFactory =
          RecordingRgbTileStoreFactory();
      final File profiled = await compositeSelectedMeteorStreaksTiledAndExport(
        frameTransforms: {
          for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
        },
        frameStores: stores,
        selectedStreaks: <SelectedMeteorStreak>[
          SelectedMeteorStreak(frameIndex: 1, streak: _Streak(1, 4, 6, 4, 1)),
        ],
        backgroundFrameIndices: <int>[0],
        intermediateTileStoreFactory: profiledFactory.call,
        exportPath: '${temp.path}${Platform.pathSeparator}profiled.bmp',
        exposureScale: 1,
        whitePoint: 1,
        renderProfile: _meteorRenderProfile(1),
      );
      final Uint8List baselineBytes = await baseline.readAsBytes();
      final Uint8List profiledBytes = await profiled.readAsBytes();
      expect(profiledBytes[54], greaterThan(baselineBytes[54]));
    } finally {
      await temp.delete(recursive: true);
    }
  });

  test(
    '異なる前景フレームの複数流星痕をタイル方式で同じ背景へ合成する',
    () async {
      const int width = 20;
      const int height = 20;
      final List<LinearRgbTileStore?> stores = <LinearRgbTileStore?>[
        _constantFrame(width, height, 0.1, 0.1, 0.1),
        _constantFrame(width, height, 9, 9, 9),
        _constantFrame(width, height, 7, 7, 7),
      ];
      final RecordingRgbTileStoreFactory factory =
          RecordingRgbTileStoreFactory();
      final Directory temp = await Directory.systemTemp.createTemp(
        'mobile-stack-meteor-multi-',
      );
      final String output = '${temp.path}${Platform.pathSeparator}result.bmp';
      try {
        final File file = await compositeSelectedMeteorStreaksTiledAndExport(
          frameTransforms: {
            for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
          },
          frameStores: stores,
          selectedStreaks: <SelectedMeteorStreak>[
            SelectedMeteorStreak(
              frameIndex: 1,
              streak: _Streak(2, 5, 8, 5, 2),
            ),
            SelectedMeteorStreak(
              frameIndex: 2,
              streak: _Streak(11, 14, 18, 14, 2),
            ),
          ],
          backgroundFrameIndices: <int>[0],
          intermediateTileStoreFactory: factory.call,
          exportPath: output,
          tileSize: 512,
          paddingPixels: 0,
          exposureScale: 1,
          whitePoint: 1,
        );
        expect(await file.exists(), isTrue);
        expect(factory.created, hasLength(2));
        final Float32List composite =
            factory.created[1].writtenTiles.single.interleavedRgb;
        expect(composite[(5 * width + 5) * 3], 9);
        expect(composite[(14 * width + 14) * 3], 7);
        expect(composite[(10 * width + 10) * 3], closeTo(0.1, 1e-6));
        expect(factory.created.every((store) => store.disposed), isTrue);
      } finally {
        await temp.delete(recursive: true);
      }
    },
  );

  test('複数候補の合成キャンセル時に背景を破棄し未完成出力をabortする', () async {
    final List<LinearRgbTileStore?> stores = <LinearRgbTileStore?>[
      _constantFrame(10, 10, 0.1, 0.1, 0.1),
      _constantFrame(10, 10, 9, 9, 9),
    ];
    final RecordingRgbTileStoreFactory factory = RecordingRgbTileStoreFactory();
    await expectLater(
      compositeSelectedMeteorStreaksTiledAndExport(
        frameTransforms: {
          for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
        },
        frameStores: stores,
        selectedStreaks: <SelectedMeteorStreak>[
          SelectedMeteorStreak(
            frameIndex: 1,
            streak: _Streak(1, 5, 8, 5),
          ),
        ],
        backgroundFrameIndices: <int>[0],
        intermediateTileStoreFactory: factory.call,
        exportPath: '/tmp/unused.bmp',
        isCancelled: () => factory.created.length >= 2,
      ),
      throwsA(isA<TiledStackingCancelled>()),
    );
    expect(factory.created, hasLength(2));
    expect(factory.created[0].disposed, isTrue);
    expect(factory.created[1].aborted, isTrue);
  });

  test(
    '選択したフレームの流星痕が、背景フレームへ合成されて実際にBMP'
    'ファイルとして書き出される',
    () async {
      const int width = 30;
      const int height = 20;
      final InMemoryRgbTileStore backgroundStore =
          _constantFrame(width, height, 0.05, 0.05, 0.08); // 暗い夜空
      final InMemoryRgbTileStore foregroundStore =
          _constantFrame(width, height, 9.0, 9.0, 9.0); // 明るい流星フレーム
      final List<LinearRgbTileStore?> frameStores = <LinearRgbTileStore?>[
        backgroundStore,
        foregroundStore,
      ];
      final _Streak streak = _Streak(5, 10, 25, 10, 2);

      final Directory tempDir = await Directory.systemTemp.createTemp(
        'mobile-stack-meteor-composite-',
      );
      final String exportPath =
          '${tempDir.path}${Platform.pathSeparator}result.bmp';
      try {
        final File written = await compositeSelectedMeteorCandidateAndExport(
          frameTransforms: {
            for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
          },
          frameStores: frameStores,
          foregroundFrameIndex: 1,
          backgroundFrameIndex: 0,
          selectedStreaks: <StreakShape>[streak],
          exportPath: exportPath,
          paddingPixels: 1,
        );

        expect(await written.exists(), isTrue);
        final Uint8List bytes = await written.readAsBytes();
        expect(bytes[0], 0x42); // 'B'
        expect(bytes[1], 0x4d); // 'M'
        final ByteData view = ByteData.sublistView(bytes);
        expect(view.getInt32(18, Endian.little), width);
        expect(view.getInt32(22, Endian.little), height);
      } finally {
        await tempDir.delete(recursive: true);
      }
    },
  );

  test('foregroundFrameIndexが範囲外だとArgumentErrorを投げる', () async {
    final List<LinearRgbTileStore?> frameStores = <LinearRgbTileStore?>[
      _constantFrame(10, 10, 0.1, 0.1, 0.1),
    ];
    await expectLater(
      compositeSelectedMeteorCandidateAndExport(
        frameTransforms: {
          for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
        },
        frameStores: frameStores,
        foregroundFrameIndex: 5,
        backgroundFrameIndex: 0,
        selectedStreaks: <StreakShape>[_Streak(1, 1, 5, 5)],
        exportPath: '/tmp/unused.bmp',
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test('backgroundFrameIndexが範囲外だとArgumentErrorを投げる', () async {
    final List<LinearRgbTileStore?> frameStores = <LinearRgbTileStore?>[
      _constantFrame(10, 10, 0.1, 0.1, 0.1),
    ];
    await expectLater(
      compositeSelectedMeteorCandidateAndExport(
        frameTransforms: {
          for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
        },
        frameStores: frameStores,
        foregroundFrameIndex: 0,
        backgroundFrameIndex: -1,
        selectedStreaks: <StreakShape>[_Streak(1, 1, 5, 5)],
        exportPath: '/tmp/unused.bmp',
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test('foregroundのフレームがデコード失敗(null)だとArgumentErrorを投げる', () async {
    final List<LinearRgbTileStore?> frameStores = <LinearRgbTileStore?>[
      _constantFrame(10, 10, 0.1, 0.1, 0.1),
      null,
    ];
    await expectLater(
      compositeSelectedMeteorCandidateAndExport(
        frameTransforms: {
          for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
        },
        frameStores: frameStores,
        foregroundFrameIndex: 1,
        backgroundFrameIndex: 0,
        selectedStreaks: <StreakShape>[_Streak(1, 1, 5, 5)],
        exportPath: '/tmp/unused.bmp',
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test('backgroundのフレームがデコード失敗(null)だとArgumentErrorを投げる', () async {
    final List<LinearRgbTileStore?> frameStores = <LinearRgbTileStore?>[
      null,
      _constantFrame(10, 10, 0.1, 0.1, 0.1),
    ];
    await expectLater(
      compositeSelectedMeteorCandidateAndExport(
        frameTransforms: {
          for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
        },
        frameStores: frameStores,
        foregroundFrameIndex: 1,
        backgroundFrameIndex: 0,
        selectedStreaks: <StreakShape>[_Streak(1, 1, 5, 5)],
        exportPath: '/tmp/unused.bmp',
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test(
    '空の選択リストを渡すと(compositeSelectedStreaksを経由して)例外を'
    '投げる',
    () async {
      final List<LinearRgbTileStore?> frameStores = <LinearRgbTileStore?>[
        _constantFrame(10, 10, 0.1, 0.1, 0.1),
        _constantFrame(10, 10, 9.0, 9.0, 9.0),
      ];
      await expectLater(
        compositeSelectedMeteorCandidateAndExport(
          frameTransforms: {
            for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
          },
          frameStores: frameStores,
          foregroundFrameIndex: 1,
          backgroundFrameIndex: 0,
          selectedStreaks: const <StreakShape>[],
          exportPath: '/tmp/unused.bmp',
        ),
        throwsA(anything),
      );
    },
  );

  group('compositeSelectedMeteorCandidateWithStackedBackgroundAndExport', () {
    test(
      '複数の背景フレームをkappa-sigma合成した上に流星痕を合成し、実際に'
      'BMPファイルとして書き出される',
      () async {
        const int width = 20;
        const int height = 16;
        final List<LinearRgbTileStore?> frameStores = <LinearRgbTileStore?>[
          _constantFrame(width, height, 0.05, 0.05, 0.08), // background 0
          _constantFrame(width, height, 0.05, 0.05, 0.08), // background 1
          _constantFrame(width, height, 9.0, 9.0, 9.0), // foreground (meteor)
        ];
        final RecordingRgbTileStoreFactory backgroundFactory =
            RecordingRgbTileStoreFactory();
        final _Streak streak = _Streak(3, 8, 17, 8, 2);

        final Directory tempDir = await Directory.systemTemp.createTemp(
          'mobile-stack-meteor-stacked-bg-',
        );
        final String exportPath =
            '${tempDir.path}${Platform.pathSeparator}result.bmp';
        try {
          final File written =
              await compositeSelectedMeteorCandidateWithStackedBackgroundAndExport(
            frameTransforms: {
              for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
            },
            frameStores: frameStores,
            foregroundFrameIndex: 2,
            backgroundFrameIndices: <int>[0, 1],
            selectedStreaks: <StreakShape>[streak],
            backgroundTileStoreFactory: backgroundFactory.call,
            exportPath: exportPath,
            tileSize: 512,
            paddingPixels: 1,
          );

          expect(await written.exists(), isTrue);
          final Uint8List bytes = await written.readAsBytes();
          expect(bytes[0], 0x42);
          expect(bytes[1], 0x4d);
          final ByteData view = ByteData.sublistView(bytes);
          expect(view.getInt32(18, Endian.little), width);
          expect(view.getInt32(22, Endian.little), height);
          // 中間の合成背景ストアは、最終出力後に破棄されているはず。
          expect(backgroundFactory.latest!.disposed, isTrue);
        } finally {
          await tempDir.delete(recursive: true);
        }
      },
    );

    test(
      'kappa-sigma合成は、一部の背景フレームだけに写り込んだ無関係な明る'
      'い光跡(他の人工衛星や飛行機など)を正しく棄却する'
      '(比較明合成ではなくkappa-sigmaを選んだ理由そのものを検証)',
      () async {
        const int width = 10;
        const int height = 10;
        const double normalBackground = 0.1;
        const double outlierSpike = 50.0; // 無関係な明るい光跡を模擬

        // 3枚の背景フレームのうち1枚だけに、無関係な明るいスパイクが
        // 混入している状況を再現する。
        final Float32List frame0Rgb = Float32List(width * height * 3)
          ..fillRange(0, width * height * 3, normalBackground);
        final Float32List frame1Rgb = Float32List(width * height * 3)
          ..fillRange(0, width * height * 3, normalBackground);
        final Float32List frame2Rgb = Float32List(width * height * 3)
          ..fillRange(0, width * height * 3, normalBackground);
        // frame2 のある1ピクセルだけに外れ値を混入。
        const int spikePixel = 55; // (5,5) 付近
        frame2Rgb[spikePixel * 3] = outlierSpike;
        frame2Rgb[spikePixel * 3 + 1] = outlierSpike;
        frame2Rgb[spikePixel * 3 + 2] = outlierSpike;

        final List<LinearRgbTileStore?> frameStores = <LinearRgbTileStore?>[
          InMemoryRgbTileStore(
            width: width,
            height: height,
            interleavedRgb: frame0Rgb,
          ),
          InMemoryRgbTileStore(
            width: width,
            height: height,
            interleavedRgb: frame1Rgb,
          ),
          InMemoryRgbTileStore(
            width: width,
            height: height,
            interleavedRgb: frame2Rgb,
          ),
          _constantFrame(width, height, 9.0, 9.0, 9.0), // foreground
        ];
        final RecordingRgbTileStoreFactory backgroundFactory =
            RecordingRgbTileStoreFactory();
        // 流星痕は外れ値ピクセルから離れた場所に置く。
        final _Streak streak = _Streak(0, 0, 1, 0, 1);

        final Directory tempDir = await Directory.systemTemp.createTemp(
          'mobile-stack-meteor-stacked-bg-outlier-',
        );
        final String exportPath =
            '${tempDir.path}${Platform.pathSeparator}result.bmp';
        try {
          await compositeSelectedMeteorCandidateWithStackedBackgroundAndExport(
            frameTransforms: {
              for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
            },
            frameStores: frameStores,
            foregroundFrameIndex: 3,
            backgroundFrameIndices: <int>[0, 1, 2],
            selectedStreaks: <StreakShape>[streak],
            backgroundTileStoreFactory: backgroundFactory.call,
            exportPath: exportPath,
            tileSize: 512,
            paddingPixels: 1,
            kappa: 1.0,
            // 自動露出推定に頼らず、生の合成値を直接比較できるようにする。
            exposureScale: 1.0,
            whitePoint: 1.0,
          );

          // 合成前の背景ストア(コミット前に書き込まれた値)を直接検査する。
          final Float32List combined =
              backgroundFactory.latest!.writtenTiles.single.interleavedRgb;
          final double combinedSpikeValue = combined[spikePixel * 3];
          // kappa-sigmaにより外れ値は棄却され、残り2フレーム(0.1)の
          // 平均に近い値になるはず -- 外れ値(50.0)にはほど遠い。
          expect(
            combinedSpikeValue,
            lessThan(1.0),
            reason: 'expected the outlier spike (50.0) to be rejected, '
                'leaving a value near the normal background (0.1), got '
                '$combinedSpikeValue',
          );
        } finally {
          await tempDir.delete(recursive: true);
        }
      },
    );

    test('foregroundFrameIndexが範囲外だとArgumentErrorを投げる', () async {
      final RecordingRgbTileStoreFactory backgroundFactory =
          RecordingRgbTileStoreFactory();
      await expectLater(
        compositeSelectedMeteorCandidateWithStackedBackgroundAndExport(
          frameTransforms: {
            for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
          },
          frameStores: <LinearRgbTileStore?>[
            _constantFrame(10, 10, 0.1, 0.1, 0.1),
          ],
          foregroundFrameIndex: 5,
          backgroundFrameIndices: <int>[0],
          selectedStreaks: <StreakShape>[_Streak(1, 1, 5, 5)],
          backgroundTileStoreFactory: backgroundFactory.call,
          exportPath: '/tmp/unused.bmp',
        ),
        throwsA(isA<ArgumentError>()),
      );
    });

    test('backgroundFrameIndicesが空だとArgumentErrorを投げる', () async {
      final RecordingRgbTileStoreFactory backgroundFactory =
          RecordingRgbTileStoreFactory();
      await expectLater(
        compositeSelectedMeteorCandidateWithStackedBackgroundAndExport(
          frameTransforms: {
            for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
          },
          frameStores: <LinearRgbTileStore?>[
            _constantFrame(10, 10, 0.1, 0.1, 0.1),
            _constantFrame(10, 10, 9.0, 9.0, 9.0),
          ],
          foregroundFrameIndex: 1,
          backgroundFrameIndices: const <int>[],
          selectedStreaks: <StreakShape>[_Streak(1, 1, 5, 5)],
          backgroundTileStoreFactory: backgroundFactory.call,
          exportPath: '/tmp/unused.bmp',
        ),
        throwsA(isA<ArgumentError>()),
      );
    });

    test(
      'backgroundFrameIndicesの中にデコード失敗(null)フレームがあると'
      'ArgumentErrorを投げる',
      () async {
        final RecordingRgbTileStoreFactory backgroundFactory =
            RecordingRgbTileStoreFactory();
        await expectLater(
          compositeSelectedMeteorCandidateWithStackedBackgroundAndExport(
            frameTransforms: {
              for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
            },
            frameStores: <LinearRgbTileStore?>[
              null,
              _constantFrame(10, 10, 9.0, 9.0, 9.0),
            ],
            foregroundFrameIndex: 1,
            backgroundFrameIndices: <int>[0],
            selectedStreaks: <StreakShape>[_Streak(1, 1, 5, 5)],
            backgroundTileStoreFactory: backgroundFactory.call,
            exportPath: '/tmp/unused.bmp',
          ),
          throwsA(isA<ArgumentError>()),
        );
      },
    );

    test('背景フレームの寸法が前景フレームと異なるとArgumentErrorを投げる', () async {
      final RecordingRgbTileStoreFactory backgroundFactory =
          RecordingRgbTileStoreFactory();
      await expectLater(
        compositeSelectedMeteorCandidateWithStackedBackgroundAndExport(
          frameTransforms: {
            for (int i = 0; i < 32; i++) i: AffineSamplingTransform.identity()
          },
          frameStores: <LinearRgbTileStore?>[
            _constantFrame(5, 5, 0.1, 0.1, 0.1), // 寸法が違う
            _constantFrame(10, 10, 9.0, 9.0, 9.0),
          ],
          foregroundFrameIndex: 1,
          backgroundFrameIndices: <int>[0],
          selectedStreaks: <StreakShape>[_Streak(1, 1, 5, 5)],
          backgroundTileStoreFactory: backgroundFactory.call,
          exportPath: '/tmp/unused.bmp',
        ),
        throwsA(isA<ArgumentError>()),
      );
    });
  });

  group('defaultBackgroundFrameIndices', () {
    test('複数選択された全前景フレームを背景から除外する', () {
      final MeteorAnalysisResult result = _fakeResult(
        analyzedFlags: <bool>[true, true, true, true],
      );
      expect(
        defaultBackgroundFrameIndicesForSelectedFrames(result, <int>{1, 3}),
        orderedEquals(<int>[0, 2]),
      );
    });
    test('前景フレーム以外の全解析済みフレームを返す', () {
      final MeteorAnalysisResult result = _fakeResult(
        analyzedFlags: <bool>[true, true, true, true],
      );
      expect(
        defaultBackgroundFrameIndices(result, 2),
        orderedEquals(<int>[0, 1, 3]),
      );
    });

    test('デコード失敗(未解析)フレームは除外される', () {
      final MeteorAnalysisResult result = _fakeResult(
        analyzedFlags: <bool>[true, false, true, true],
      );
      expect(
        defaultBackgroundFrameIndices(result, 2),
        orderedEquals(<int>[0, 3]),
      );
    });

    test(
      'デフォルトでは、自身の候補を持つフレームも背景候補から除外される',
      () {
        final MeteorAnalysisResult result = _fakeResult(
          analyzedFlags: <bool>[true, true, true, true],
          candidateFrameIndices: <int>[1], // frame1は別の候補を持つ
        );
        expect(
          defaultBackgroundFrameIndices(result, 2),
          orderedEquals(<int>[0, 3]),
        );
      },
    );

    test(
      'excludeFrameIndicesWithCandidates: false にすると、候補を持つ'
      'フレームも含める',
      () {
        final MeteorAnalysisResult result = _fakeResult(
          analyzedFlags: <bool>[true, true, true, true],
          candidateFrameIndices: <int>[1],
        );
        expect(
          defaultBackgroundFrameIndices(
            result,
            2,
            excludeFrameIndicesWithCandidates: false,
          ),
          orderedEquals(<int>[0, 1, 3]),
        );
      },
    );

    test('foregroundFrameIndexが範囲外だとArgumentErrorを投げる', () {
      final MeteorAnalysisResult result = _fakeResult(
        analyzedFlags: <bool>[true, true],
      );
      expect(
        () => defaultBackgroundFrameIndices(result, 5),
        throwsA(isA<ArgumentError>()),
      );
    });
  });
}
