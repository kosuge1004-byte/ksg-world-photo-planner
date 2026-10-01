import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/color/raw_camera_color_profile.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_decoder_registry.dart';
import 'package:mobile_stack/core/session/cfa_drizzle_milky_way_pipeline.dart';
import 'package:mobile_stack/core/stacking/registration_quality_weight.dart';

import 'support/recording_rgb_tile_store.dart';

/// Tests [registerAndDrizzleCalibratedMosaics] directly against hand-
/// built synthetic raw mosaics (stars rendered only at each mosaic's
/// own green-CFA-pattern positions, matching what a real Bayer sensor
/// actually samples), so the actual `extractGreenLuminanceFromMosaic`/
/// `detectStars`/`estimateSimilarityTransform`/`drizzleCfaTiled`
/// implementations all run end to end together. See `cfa_drizzle_
/// milky_way_pipeline.dart`'s own doc comment for why
/// [runCfaDrizzleMilkyWayPipeline]'s `JobScheduler`-driven orchestration
/// is *not* covered here.

LinearRawMosaic _blankMosaic(
  int width,
  int height,
  CfaPattern pattern, [
  double background = 0.02,
]) {
  final Float32List samples = Float32List(width * height)
    ..fillRange(0, width * height, background);
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: pattern,
    samples: samples,
  );
}

void _addGaussianStarAtGreenPositions(
  LinearRawMosaic mosaic,
  double cx,
  double cy,
  double peakAmplitude,
  double sigma,
) {
  const int radius = 6;
  for (int dy = -radius; dy <= radius; dy++) {
    for (int dx = -radius; dx <= radius; dx++) {
      final int x = cx.round() + dx;
      final int y = cy.round() + dy;
      if (x < 0 || y < 0 || x >= mosaic.width || y >= mosaic.height) {
        continue;
      }
      if (mosaic.cfaPattern.colorAt(x, y) != CfaColor.green) continue;
      final double ox = x - cx;
      final double oy = y - cy;
      final double value =
          peakAmplitude * math.exp(-(ox * ox + oy * oy) / (2 * sigma * sigma));
      mosaic.samples[y * mosaic.width + x] += value;
    }
  }
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
        peak: 4 + next() * 6,
      ),
  ];
}

({double x, double y}) _rotatePoint(
  double x,
  double y,
  double rotationDegrees,
  double centerX,
  double centerY,
) {
  final double radians = rotationDegrees * math.pi / 180;
  final double cosine = math.cos(radians);
  final double sine = math.sin(radians);
  final double ox = x - centerX;
  final double oy = y - centerY;
  return (
    x: centerX + cosine * ox - sine * oy,
    y: centerY + sine * ox + cosine * oy,
  );
}

void main() {
  test(
    '実際に回転した2フレームの位置合わせ+CFA drizzle合成が成功する'
    '(緑位置のみの合成星field + 実際の星検出・変換推定・drizzleを'
    '通しで検証)',
    () async {
      const int width = 100;
      const int height = 80;
      const double centerX = width / 2;
      const double centerY = height / 2;
      const double trueRotation = 3.0;

      final List<({double x, double y, double peak})> starTruth =
          _seededStarField(20, 4242, width.toDouble(), height.toDouble(), 15);

      final LinearRawMosaic referenceMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        _addGaussianStarAtGreenPositions(
          referenceMosaic,
          star.x,
          star.y,
          star.peak,
          1.3,
        );
      }

      final LinearRawMosaic targetMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        final moved = _rotatePoint(
          star.x,
          star.y,
          trueRotation,
          centerX,
          centerY,
        );
        _addGaussianStarAtGreenPositions(
          targetMosaic,
          moved.x,
          moved.y,
          star.peak,
          1.3,
        );
      }

      final RecordingRgbTileStoreFactory valueFactory =
          RecordingRgbTileStoreFactory();
      final RecordingRgbTileStoreFactory coverageFactory =
          RecordingRgbTileStoreFactory();

      final CfaDrizzleMilkyWayResult result =
          await registerAndDrizzleCalibratedMosaics(
        sourcePaths: <String>['ref.arw', 'target.arw'],
        mosaics: <LinearRawMosaic?>[referenceMosaic, targetMosaic],
        decodeFailures: const <int, Object?>{},
        colorProfiles: <RawCameraColorProfile?>[
          RawCameraColorProfile(
            d65XyzToCamera: const <double>[
              1,
              0,
              0,
              0,
              1,
              0,
              0,
              0,
              1,
            ],
            phaseWhiteBalance: const <double>[2, 1, 1, 1.5],
          ),
          RawCameraColorProfile(
            d65XyzToCamera: const <double>[
              1,
              0,
              0,
              0,
              1,
              0,
              0,
              0,
              1,
            ],
            phaseWhiteBalance: const <double>[1, 1, 1, 3],
          ),
        ],
        valueStoreFactory: valueFactory.call,
        coverageStoreFactory: coverageFactory.call,
        tileSize: 64,
      );

      expect(result.frameDiagnostics[0].included, isTrue);
      expect(result.frameDiagnostics[0].rotationDegrees, 0);
      expect(result.frameDiagnostics[1].included, isTrue);
      expect(
        (result.frameDiagnostics[1].rotationDegrees! - trueRotation).abs(),
        lessThan(0.05),
        reason: 'expected rotation near $trueRotation, got '
            '${result.frameDiagnostics[1].rotationDegrees}',
      );
      expect(result.frameDiagnostics[1].rmsResidual, lessThan(0.5));
      expect(result.outputColorTransform, isNotNull);

      final RecordingRgbTileStore valueStore =
          result.valueStore as RecordingRgbTileStore;
      final RecordingRgbTileStore coverageStore =
          result.coverageStore as RecordingRgbTileStore;
      expect(valueStore.isCommitted, isTrue);
      expect(coverageStore.isCommitted, isTrue);
      expect(valueStore.writtenTiles, isNotEmpty);
    },
  );

  test('異なるcamera color matrixのフレームはDrizzle前に除外する', () async {
    const int width = 60;
    const int height = 50;
    final List<({double x, double y, double peak})> stars =
        _seededStarField(15, 8128, width.toDouble(), height.toDouble(), 10);
    LinearRawMosaic scene() {
      final LinearRawMosaic mosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in stars) {
        _addGaussianStarAtGreenPositions(
          mosaic,
          star.x,
          star.y,
          star.peak,
          1.3,
        );
      }
      return mosaic;
    }

    RawCameraColorProfile profile(double first) => RawCameraColorProfile(
          d65XyzToCamera: <double>[
            first,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            1,
          ],
          phaseWhiteBalance: const <double>[1, 1, 1, 1],
        );

    final CfaDrizzleMilkyWayResult result =
        await registerAndDrizzleCalibratedMosaics(
      sourcePaths: <String>['outlier.dng', 'reference.dng', 'matching.dng'],
      mosaics: <LinearRawMosaic?>[scene(), scene(), scene()],
      decodeFailures: const <int, Object?>{},
      colorProfiles: <RawCameraColorProfile?>[
        profile(1.1),
        profile(1),
        profile(1),
      ],
      valueStoreFactory: RecordingRgbTileStoreFactory().call,
      coverageStoreFactory: RecordingRgbTileStoreFactory().call,
      minRegisteredFrames: 2,
      tileSize: 64,
    );

    expect(result.frameDiagnostics[0].included, isFalse);
    expect(result.frameDiagnostics[0].excludedReason, contains('color matrix'));
    expect(result.frameDiagnostics[1].included, isTrue);
    expect(result.frameDiagnostics[2].included, isTrue);
  });

  test(
    'デコード失敗フレームは除外され、配列位置の隣接関係はギャップを'
    '越えて正しくブリッジされる',
    () async {
      const int width = 60;
      const int height = 50;
      final LinearRawMosaic referenceMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      final List<({double x, double y, double peak})> starTruth =
          _seededStarField(15, 11, width.toDouble(), height.toDouble(), 10);
      for (final star in starTruth) {
        _addGaussianStarAtGreenPositions(
          referenceMosaic,
          star.x,
          star.y,
          star.peak,
          1.3,
        );
      }
      final LinearRawMosaic goodMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        _addGaussianStarAtGreenPositions(
          goodMosaic,
          star.x,
          star.y,
          star.peak,
          1.3,
        );
      }

      final CfaDrizzleMilkyWayResult result =
          await registerAndDrizzleCalibratedMosaics(
        sourcePaths: <String>['a.arw', 'broken.arw', 'c.arw'],
        mosaics: <LinearRawMosaic?>[referenceMosaic, null, goodMosaic],
        decodeFailures: <int, Object?>{1: StateError('decode broke')},
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        tileSize: 64,
      );

      expect(result.frameDiagnostics[0].included, isTrue);
      expect(result.frameDiagnostics[1].included, isFalse);
      expect(
        result.frameDiagnostics[1].excludedReason,
        contains('decode failed'),
      );
      expect(result.frameDiagnostics[2].included, isTrue);
    },
  );

  test(
    '使用可能なフレームがminRegisteredFrames未満だと'
    'CfaDrizzleMilkyWayRegistrationFailedを投げる',
    () async {
      final LinearRawMosaic onlyMosaic = _blankMosaic(
        20,
        20,
        CfaPattern.rggb,
      );
      await expectLater(
        registerAndDrizzleCalibratedMosaics(
          sourcePaths: <String>['only.arw'],
          mosaics: <LinearRawMosaic?>[onlyMosaic],
          decodeFailures: const <int, Object?>{},
          valueStoreFactory: RecordingRgbTileStoreFactory().call,
          coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        ),
        throwsA(isA<CfaDrizzleMilkyWayRegistrationFailed>()),
      );
    },
  );

  test(
    '全フレームがデコード失敗だとCfaDrizzleMilkyWayRegistrationFailedを'
    '投げる',
    () async {
      await expectLater(
        registerAndDrizzleCalibratedMosaics(
          sourcePaths: <String>['a.arw', 'b.arw'],
          mosaics: const <LinearRawMosaic?>[null, null],
          decodeFailures: <int, Object?>{
            0: StateError('broken'),
            1: StateError('broken'),
          },
          valueStoreFactory: RecordingRgbTileStoreFactory().call,
          coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        ),
        throwsA(isA<CfaDrizzleMilkyWayRegistrationFailed>()),
      );
    },
  );

  test('sourcePathsとmosaicsの長さが異なるとArgumentErrorを投げる', () async {
    expect(
      () => registerAndDrizzleCalibratedMosaics(
        sourcePaths: <String>['a.arw'],
        mosaics: const <LinearRawMosaic?>[null, null],
        decodeFailures: const <int, Object?>{},
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test(
    '参照フレームのregistrationWeightは常に1で、他フレームの'
    'registrationWeightは実際のrmsResidualからregistrationQualityWeight'
    'で正しく計算されている(Work95: 以前は常に重み1固定だった配線漏れの'
    '修正確認)',
    () async {
      const int width = 100;
      const int height = 80;
      const double centerX = width / 2;
      const double centerY = height / 2;
      const double trueRotation = 3.0;

      final List<({double x, double y, double peak})> starTruth =
          _seededStarField(20, 4242, width.toDouble(), height.toDouble(), 15);

      final LinearRawMosaic referenceMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        _addGaussianStarAtGreenPositions(
          referenceMosaic,
          star.x,
          star.y,
          star.peak,
          1.3,
        );
      }
      final LinearRawMosaic targetMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        final moved = _rotatePoint(
          star.x,
          star.y,
          trueRotation,
          centerX,
          centerY,
        );
        _addGaussianStarAtGreenPositions(
          targetMosaic,
          moved.x,
          moved.y,
          star.peak,
          1.3,
        );
      }

      final CfaDrizzleMilkyWayResult result =
          await registerAndDrizzleCalibratedMosaics(
        sourcePaths: <String>['ref.arw', 'target.arw'],
        mosaics: <LinearRawMosaic?>[referenceMosaic, targetMosaic],
        decodeFailures: const <int, Object?>{},
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        tileSize: 64,
      );

      expect(result.frameDiagnostics[0].registrationWeight, 1);
      final double? targetRmsResidual = result.frameDiagnostics[1].rmsResidual;
      final double? targetWeight =
          result.frameDiagnostics[1].registrationWeight;
      expect(targetRmsResidual, isNotNull);
      expect(targetWeight, isNotNull);
      // 保存されたregistrationWeightが、報告されたrmsResidualから
      // registrationQualityWeightで実際に計算した値と一致することを
      // 直接確認する(この配線こそが今回の修正対象)。
      final double expectedWeight = registrationQualityWeight(
        targetRmsResidual!,
      );
      expect((targetWeight! - expectedWeight).abs(), lessThan(1e-12));
      // 良好な位置合わせ(RMS残差が小さい)なので、重みは1に近いはず。
      expect(targetWeight, greaterThan(0.8));
    },
  );

  test(
    'residualHalfWeightRadius/minimumRegistrationWeightのパラメータが'
    '実際にregistrationQualityWeightへ転送されている',
    () async {
      const int width = 100;
      const int height = 80;
      const double centerX = width / 2;
      const double centerY = height / 2;
      const double trueRotation = 3.0;

      final List<({double x, double y, double peak})> starTruth =
          _seededStarField(20, 4242, width.toDouble(), height.toDouble(), 15);

      final LinearRawMosaic referenceMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        _addGaussianStarAtGreenPositions(
          referenceMosaic,
          star.x,
          star.y,
          star.peak,
          1.3,
        );
      }
      final LinearRawMosaic targetMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        final moved = _rotatePoint(
          star.x,
          star.y,
          trueRotation,
          centerX,
          centerY,
        );
        _addGaussianStarAtGreenPositions(
          targetMosaic,
          moved.x,
          moved.y,
          star.peak,
          1.3,
        );
      }

      // minimumRegistrationWeightを高く設定すると、実際のRMS残差に
      // 由来する重みより大きい値でクランプされるはず。
      final CfaDrizzleMilkyWayResult result =
          await registerAndDrizzleCalibratedMosaics(
        sourcePaths: <String>['ref.arw', 'target.arw'],
        mosaics: <LinearRawMosaic?>[referenceMosaic, targetMosaic],
        decodeFailures: const <int, Object?>{},
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        tileSize: 64,
        // 極端に小さい半値半径にすることで、通常なら重みが下がるはずの
        // 状況を作り、minimumRegistrationWeightのクランプが効いている
        // ことを確認する(1e-6は、どれほど良好な位置合わせでも
        // rmsResidualが厳密に0.0にならない限りクランプが働くよう、
        // 十分に極端な値として選んだ)。
        residualHalfWeightRadius: 1e-6,
        minimumRegistrationWeight: 0.9,
      );

      expect(result.frameDiagnostics[1].registrationWeight, 0.9);
    },
  );

  test(
    'runCfaDrizzleMilkyWayPipeline: masterDarkとdarkFramePathsを同時に'
    '指定するとArgumentErrorを投げる(Work105)',
    () async {
      final CfaDrizzleMilkyWayDecodingConfig decodingConfig =
          CfaDrizzleMilkyWayDecodingConfig(
        decoderRegistry: RawDecoderRegistry(const <RawDecoder>[]),
      );
      final LinearRawMosaic fakeMasterDark = LinearRawMosaic(
        width: 2,
        height: 2,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List(4),
      );
      await expectLater(
        runCfaDrizzleMilkyWayPipeline(
          sourcePaths: <String>['a.arw', 'b.arw'],
          decodingConfig: decodingConfig,
          valueStoreFactory: RecordingRgbTileStoreFactory().call,
          coverageStoreFactory: RecordingRgbTileStoreFactory().call,
          masterDark: fakeMasterDark,
          darkFramePaths: const <String>['dark0.arw', 'dark1.arw'],
        ),
        throwsA(isA<ArgumentError>()),
      );
    },
  );

  test(
    'runCfaDrizzleMilkyWayPipeline: masterFlatとflatFramePathsを同時に'
    '指定するとArgumentErrorを投げる(Work105)',
    () async {
      final CfaDrizzleMilkyWayDecodingConfig decodingConfig =
          CfaDrizzleMilkyWayDecodingConfig(
        decoderRegistry: RawDecoderRegistry(const <RawDecoder>[]),
      );
      final LinearRawMosaic fakeMasterFlat = LinearRawMosaic(
        width: 2,
        height: 2,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(<double>[1, 1, 1, 1]),
      );
      await expectLater(
        runCfaDrizzleMilkyWayPipeline(
          sourcePaths: <String>['a.arw', 'b.arw'],
          decodingConfig: decodingConfig,
          valueStoreFactory: RecordingRgbTileStoreFactory().call,
          coverageStoreFactory: RecordingRgbTileStoreFactory().call,
          masterFlat: fakeMasterFlat,
          flatFramePaths: const <String>['flat0.arw'],
        ),
        throwsA(isA<ArgumentError>()),
      );
    },
  );

  test(
    'enableRobustRejection=trueの場合、出力タイル単位で全フレームを'
    'ロバスト結合する経路が正常に完走する',
    () async {
      // 3フレーム(参照+回転無しの2フレーム)を用意し、
      // rejectionMinFramesForRejectionを2に下げて、少数フレームでも
      // 棄却ロジック自体が機能する状況で配線を検証する。
      const int width = 60;
      const int height = 50;
      final List<({double x, double y, double peak})> starTruth =
          _seededStarField(10, 99, width.toDouble(), height.toDouble(), 12);

      LinearRawMosaic buildMosaic() {
        final LinearRawMosaic mosaic = _blankMosaic(
          width,
          height,
          CfaPattern.rggb,
        );
        for (final star in starTruth) {
          _addGaussianStarAtGreenPositions(
            mosaic,
            star.x,
            star.y,
            star.peak,
            1.3,
          );
        }
        return mosaic;
      }

      final LinearRawMosaic referenceMosaic = buildMosaic();
      final LinearRawMosaic targetMosaic1 = buildMosaic();
      final LinearRawMosaic targetMosaic2 = buildMosaic();

      final RecordingRgbTileStoreFactory valueFactory =
          RecordingRgbTileStoreFactory();
      final RecordingRgbTileStoreFactory coverageFactory =
          RecordingRgbTileStoreFactory();

      final CfaDrizzleMilkyWayResult result =
          await registerAndDrizzleCalibratedMosaics(
        sourcePaths: <String>['ref.arw', 'target1.arw', 'target2.arw'],
        mosaics: <LinearRawMosaic?>[
          referenceMosaic,
          targetMosaic1,
          targetMosaic2,
        ],
        decodeFailures: const <int, Object?>{},
        valueStoreFactory: valueFactory.call,
        coverageStoreFactory: coverageFactory.call,
        tileSize: 32,
        enableRobustRejection: true,
        rejectionMinFramesForRejection: 2,
      );

      expect(result.frameDiagnostics[0].included, isTrue);
      expect(result.frameDiagnostics[1].included, isTrue);
      expect(result.frameDiagnostics[2].included, isTrue);
      expect((result.valueStore as RecordingRgbTileStore).isCommitted, isTrue);
      expect(
        (result.coverageStore as RecordingRgbTileStore).isCommitted,
        isTrue,
      );
    },
  );

  test(
    'useComprehensiveFrameWeighting=trueの場合、星の形状・検出数を'
    '加味した複合品質重みが実際に計算され、既存のregistrationQuality'
    'Weightのみの値とは独立して動作する(Work116: 配線の検証)',
    () async {
      const int width = 100;
      const int height = 80;
      const double centerX = width / 2;
      const double centerY = height / 2;
      const double trueRotation = 3.0;

      final List<({double x, double y, double peak})> starTruth =
          _seededStarField(20, 4242, width.toDouble(), height.toDouble(), 15);

      final LinearRawMosaic referenceMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        _addGaussianStarAtGreenPositions(
          referenceMosaic,
          star.x,
          star.y,
          star.peak,
          1.3,
        );
      }
      final LinearRawMosaic targetMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        final moved = _rotatePoint(
          star.x,
          star.y,
          trueRotation,
          centerX,
          centerY,
        );
        _addGaussianStarAtGreenPositions(
          targetMosaic,
          moved.x,
          moved.y,
          star.peak,
          1.3,
        );
      }

      final CfaDrizzleMilkyWayResult resultWithout =
          await registerAndDrizzleCalibratedMosaics(
        sourcePaths: <String>['ref.arw', 'target.arw'],
        mosaics: <LinearRawMosaic?>[referenceMosaic, targetMosaic],
        decodeFailures: const <int, Object?>{},
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        tileSize: 64,
      );
      final CfaDrizzleMilkyWayResult resultWith =
          await registerAndDrizzleCalibratedMosaics(
        sourcePaths: <String>['ref.arw', 'target.arw'],
        mosaics: <LinearRawMosaic?>[referenceMosaic, targetMosaic],
        decodeFailures: const <int, Object?>{},
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        tileSize: 64,
        useComprehensiveFrameWeighting: true,
      );

      expect(resultWithout.frameDiagnostics[1].registrationWeight, isNotNull);
      expect(resultWith.frameDiagnostics[1].registrationWeight, isNotNull);
      // 複合重みは、単純なregistrationQualityWeightに星形状・検出数の
      // 要因(いずれも1以下の乗数)を掛け合わせるため、常に元の値以下に
      // なるはず(星検出数が参照と同数以上、かつ星形状が完全に丸である
      // 特殊な場合を除く)。少なくとも上限は超えないことを確認する。
      expect(
        resultWith.frameDiagnostics[1].registrationWeight!,
        lessThanOrEqualTo(
          resultWithout.frameDiagnostics[1].registrationWeight!,
        ),
      );
    },
  );

  test(
    'usePsfRefinement=trueの場合、PSF精緻化を経由した登録・drizzleが'
    '正常に完走する(Work118: 配線の検証)',
    () async {
      const int width = 100;
      const int height = 80;
      const double centerX = width / 2;
      const double centerY = height / 2;
      const double trueRotation = 3.0;

      final List<({double x, double y, double peak})> starTruth =
          _seededStarField(20, 4242, width.toDouble(), height.toDouble(), 15);

      final LinearRawMosaic referenceMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        _addGaussianStarAtGreenPositions(
          referenceMosaic,
          star.x,
          star.y,
          star.peak,
          1.3,
        );
      }
      final LinearRawMosaic targetMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        final moved = _rotatePoint(
          star.x,
          star.y,
          trueRotation,
          centerX,
          centerY,
        );
        _addGaussianStarAtGreenPositions(
          targetMosaic,
          moved.x,
          moved.y,
          star.peak,
          1.3,
        );
      }

      final CfaDrizzleMilkyWayResult result =
          await registerAndDrizzleCalibratedMosaics(
        sourcePaths: <String>['ref.arw', 'target.arw'],
        mosaics: <LinearRawMosaic?>[referenceMosaic, targetMosaic],
        decodeFailures: const <int, Object?>{},
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        tileSize: 64,
        usePsfRefinement: true,
      );

      expect(result.frameDiagnostics[0].included, isTrue);
      expect(result.frameDiagnostics[1].included, isTrue);
      expect(
        (result.frameDiagnostics[1].rotationDegrees! - trueRotation).abs(),
        lessThan(0.1),
        reason: 'expected rotation near $trueRotation even with PSF '
            'refinement enabled, got '
            '${result.frameDiagnostics[1].rotationDegrees}',
      );
    },
  );

  test(
    'enableLocalRegistration=trueの場合、局所補正場のフィット・'
    'drizzleへの反映を経由した登録・drizzleが正常に完走する'
    '(Work122: 配線の検証)',
    () async {
      const int width = 100;
      const int height = 80;
      const double centerX = width / 2;
      const double centerY = height / 2;
      const double trueRotation = 3.0;

      final List<({double x, double y, double peak})> starTruth =
          _seededStarField(20, 4242, width.toDouble(), height.toDouble(), 15);

      final LinearRawMosaic referenceMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        _addGaussianStarAtGreenPositions(
          referenceMosaic,
          star.x,
          star.y,
          star.peak,
          1.3,
        );
      }
      final LinearRawMosaic targetMosaic = _blankMosaic(
        width,
        height,
        CfaPattern.rggb,
      );
      for (final star in starTruth) {
        final moved = _rotatePoint(
          star.x,
          star.y,
          trueRotation,
          centerX,
          centerY,
        );
        _addGaussianStarAtGreenPositions(
          targetMosaic,
          moved.x,
          moved.y,
          star.peak,
          1.3,
        );
      }

      final CfaDrizzleMilkyWayResult result =
          await registerAndDrizzleCalibratedMosaics(
        sourcePaths: <String>['ref.arw', 'target.arw'],
        mosaics: <LinearRawMosaic?>[referenceMosaic, targetMosaic],
        decodeFailures: const <int, Object?>{},
        valueStoreFactory: RecordingRgbTileStoreFactory().call,
        coverageStoreFactory: RecordingRgbTileStoreFactory().call,
        tileSize: 64,
        enableLocalRegistration: true,
        // マッチ数が20フレーム(星)程度なので、6係数*デフォルト4=24
        // より少ない可能性が高い。既定の安全策(マッチ不足時は
        // フィットしない)が働くことも含めて配線を検証するため、
        // 閾値を下げて実際にフィットが行われる状況も作る。
        localRegistrationMinimumMatchesPerCoefficient: 1,
      );

      expect(result.frameDiagnostics[0].included, isTrue);
      expect(result.frameDiagnostics[1].included, isTrue);
      expect(
        (result.frameDiagnostics[1].rotationDegrees! - trueRotation).abs(),
        lessThan(0.1),
        reason: 'expected rotation near $trueRotation even with local '
            'registration enabled, got '
            '${result.frameDiagnostics[1].rotationDegrees}',
      );
    },
  );
}
