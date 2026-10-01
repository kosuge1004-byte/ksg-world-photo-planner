import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_decoder_registry.dart';
import 'package:mobile_stack/core/registration/tiled_affine_rgb_resampler.dart'
    show ResamplingInterpolation;
import 'package:mobile_stack/core/session/milky_way_pipeline.dart';
import 'package:mobile_stack/core/stacking/registration_quality_weight.dart';
import 'package:mobile_stack/core/stacking/tiled_kappa_sigma_combiner.dart'
    show TiledStackingCancelled;

import 'support/in_memory_rgb_tile_store.dart';
import 'support/recording_rgb_tile_store.dart';

/// Tests [registerAndCombineDecodedFrames] directly against hand-built
/// fake tile stores, containing synthetic rendered star fields (not
/// hand-built star lists) so the *actual* `detectStars` and
/// `estimateSimilarityTransform` implementations run end to end — see
/// `milky_way_pipeline.dart`'s own doc comment for why
/// [runMilkyWayPipeline]'s `JobScheduler`-driven orchestration is *not*
/// covered here.

void _addGaussianStar(
  InMemoryRgbTileStoreBuilder builder,
  double cx,
  double cy,
  double peakAmplitude,
  double sigma, [
  int radius = 6,
]) {
  for (int dy = -radius; dy <= radius; dy++) {
    for (int dx = -radius; dx <= radius; dx++) {
      final int x = cx.round() + dx;
      final int y = cy.round() + dy;
      if (x < 0 || y < 0 || x >= builder.width || y >= builder.height) {
        continue;
      }
      final double ox = x - cx;
      final double oy = y - cy;
      final double value =
          peakAmplitude * math.exp(-(ox * ox + oy * oy) / (2 * sigma * sigma));
      builder.addGreen(x, y, value);
    }
  }
}

/// A tiny helper for building a synthetic RGB frame (background plus
/// however many stars) as an [InMemoryRgbTileStore] -- only the green
/// channel is populated with star signal (matching `milky_way_pipeline.
/// dart`'s own `_greenChannelOf`, which is all `detectStars` ever sees),
/// with red/blue left at the same flat background for a mildly more
/// realistic (if not photometrically meaningful) fixture.
final class InMemoryRgbTileStoreBuilder {
  InMemoryRgbTileStoreBuilder(
    this.width,
    this.height, [
    double background = 0.15,
  ]) : _rgb = Float32List(width * height * 3) {
    for (int pixel = 0; pixel < width * height; pixel++) {
      _rgb[pixel * 3] = background;
      _rgb[pixel * 3 + 1] = background;
      _rgb[pixel * 3 + 2] = background;
    }
  }

  final int width;
  final int height;
  final Float32List _rgb;

  void addGreen(int x, int y, double value) {
    _rgb[(y * width + x) * 3 + 1] += value;
  }

  InMemoryRgbTileStore build() =>
      InMemoryRgbTileStore(width: width, height: height, interleavedRgb: _rgb);
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
  test('2フレーム(基準+回転フレーム)の位置合わせと合成が成功する', () async {
    const int width = 200;
    const int height = 160;
    const double centerX = width / 2;
    const double centerY = height / 2;
    const double trueRotation = 3.0;
    const double trueDx = 2.5;
    const double trueDy = -1.5;

    final List<({double x, double y, double peak})> truth = _seededStarField(
      24,
      4242,
      width.toDouble(),
      height.toDouble(),
      20,
    );

    final InMemoryRgbTileStoreBuilder referenceBuilder =
        InMemoryRgbTileStoreBuilder(width, height);
    for (final star in truth) {
      _addGaussianStar(referenceBuilder, star.x, star.y, star.peak, 1.3);
    }
    final InMemoryRgbTileStore referenceStore = referenceBuilder.build();

    final InMemoryRgbTileStoreBuilder targetBuilder =
        InMemoryRgbTileStoreBuilder(width, height);
    for (final star in truth) {
      final moved = _rotatePoint(
        star.x,
        star.y,
        trueRotation,
        centerX,
        centerY,
        trueDx,
        trueDy,
      );
      _addGaussianStar(targetBuilder, moved.x, moved.y, star.peak, 1.3);
    }
    final InMemoryRgbTileStore targetStore = targetBuilder.build();

    final RecordingRgbTileStoreFactory outputFactory =
        RecordingRgbTileStoreFactory();
    final MilkyWayPipelineResult result = await registerAndCombineDecodedFrames(
      sourcePaths: <String>['ref.arw', 'target.arw'],
      frameStores: <LinearRgbTileStore?>[referenceStore, targetStore],
      decodeFailures: const <int, Object?>{},
      outputTileStoreFactory: outputFactory.call,
      tileSize: 512,
    );

    expect(result.frameDiagnostics, hasLength(2));
    final MilkyWayFrameDiagnostics referenceDiagnostics =
        result.frameDiagnostics[0];
    final MilkyWayFrameDiagnostics targetDiagnostics =
        result.frameDiagnostics[1];
    expect(referenceDiagnostics.included, isTrue);
    expect(referenceDiagnostics.rotationDegrees, 0);
    expect(targetDiagnostics.included, isTrue);
    expect(
      (targetDiagnostics.rotationDegrees! - trueRotation).abs(),
      lessThan(0.05),
      reason: 'expected rotation near $trueRotation, got '
          '${targetDiagnostics.rotationDegrees}',
    );
    expect(targetDiagnostics.rmsResidual, lessThan(0.5));
    expect(targetDiagnostics.matchedStarCount, greaterThanOrEqualTo(5));
    expect((targetDiagnostics.sourceOffsetX! - trueDx).abs(), lessThan(0.5));
    expect((targetDiagnostics.sourceOffsetY! - trueDy).abs(), lessThan(0.5));

    final RecordingRgbTileStore recorded =
        result.tileStore as RecordingRgbTileStore;
    expect(recorded.isCommitted, isTrue);
    expect(recorded.writtenTiles, isNotEmpty);
  });

  test('ユーザー指定frame 2を自動選択より優先してidentity基準にする', () async {
    const int width = 200;
    const int height = 160;
    final List<({double x, double y, double peak})> truth = _seededStarField(
      24,
      9191,
      width.toDouble(),
      height.toDouble(),
      20,
    );
    final InMemoryRgbTileStoreBuilder first = InMemoryRgbTileStoreBuilder(
      width,
      height,
    );
    final InMemoryRgbTileStoreBuilder second = InMemoryRgbTileStoreBuilder(
      width,
      height,
    );
    for (final star in truth) {
      _addGaussianStar(first, star.x, star.y, star.peak * 1.5, 1.3);
      final moved = _rotatePoint(
        star.x,
        star.y,
        2,
        width / 2,
        height / 2,
        2,
        -1,
      );
      _addGaussianStar(second, moved.x, moved.y, star.peak, 1.3);
    }

    final MilkyWayPipelineResult result = await registerAndCombineDecodedFrames(
      sourcePaths: const <String>['auto-quality-winner.arw', 'chosen.arw'],
      frameStores: <LinearRgbTileStore?>[first.build(), second.build()],
      decodeFailures: const <int, Object?>{},
      outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
      referenceIndex: 1,
      tileSize: 512,
    );

    expect(result.frameDiagnostics[1].sourcePath, 'chosen.arw');
    expect(result.frameDiagnostics[1].included, isTrue);
    expect(result.frameDiagnostics[1].rotationDegrees, 0);
    expect(result.frameDiagnostics[1].sourceOffsetX, 0);
    expect(result.frameDiagnostics[1].sourceOffsetY, 0);
    expect(result.frameDiagnostics[0].included, isTrue);
  });

  test('デコードに失敗したフレームは除外され診断に記録される', () async {
    const int width = 100;
    const int height = 100;
    final List<({double x, double y, double peak})> truth = _seededStarField(
      20,
      11,
      width.toDouble(),
      height.toDouble(),
      15,
    );
    final InMemoryRgbTileStoreBuilder referenceBuilder =
        InMemoryRgbTileStoreBuilder(width, height);
    for (final star in truth) {
      _addGaussianStar(referenceBuilder, star.x, star.y, star.peak, 1.3);
    }
    final InMemoryRgbTileStore referenceStore = referenceBuilder.build();

    final InMemoryRgbTileStoreBuilder targetBuilder =
        InMemoryRgbTileStoreBuilder(width, height);
    for (final star in truth) {
      _addGaussianStar(targetBuilder, star.x, star.y, star.peak, 1.3);
    }
    final InMemoryRgbTileStore targetStore = targetBuilder.build();

    final RecordingRgbTileStoreFactory outputFactory =
        RecordingRgbTileStoreFactory();
    final MilkyWayPipelineResult result = await registerAndCombineDecodedFrames(
      sourcePaths: <String>['ref.arw', 'broken.arw', 'target.arw'],
      frameStores: <LinearRgbTileStore?>[referenceStore, null, targetStore],
      decodeFailures: <int, Object?>{1: StateError('decode broke')},
      outputTileStoreFactory: outputFactory.call,
      tileSize: 512,
    );

    expect(result.frameDiagnostics[0].included, isTrue);
    expect(result.frameDiagnostics[1].included, isFalse);
    expect(
      result.frameDiagnostics[1].excludedReason,
      contains('decode failed'),
    );
    expect(result.frameDiagnostics[2].included, isTrue);
  });

  test('位置合わせに失敗したフレームは除外されるが、残りが十分あれば処理は成功する', () async {
    const int width = 100;
    const int height = 100;
    final List<({double x, double y, double peak})> truth = _seededStarField(
      20,
      22,
      width.toDouble(),
      height.toDouble(),
      15,
    );
    final InMemoryRgbTileStoreBuilder referenceBuilder =
        InMemoryRgbTileStoreBuilder(width, height);
    for (final star in truth) {
      _addGaussianStar(referenceBuilder, star.x, star.y, star.peak, 1.3);
    }
    final InMemoryRgbTileStore referenceStore = referenceBuilder.build();

    // 一致する星が全く無い、無関係な星配置のフレーム(位置合わせが
    // 失敗するはず)。
    final List<({double x, double y, double peak})> unrelated =
        _seededStarField(20, 999, width.toDouble(), height.toDouble(), 15);
    final InMemoryRgbTileStoreBuilder badBuilder = InMemoryRgbTileStoreBuilder(
      width,
      height,
    );
    for (final star in unrelated) {
      _addGaussianStar(badBuilder, star.x, star.y, star.peak, 1.3);
    }
    final InMemoryRgbTileStore badStore = badBuilder.build();

    // 基準と一致する2つ目の良好なフレーム。
    final InMemoryRgbTileStoreBuilder goodBuilder = InMemoryRgbTileStoreBuilder(
      width,
      height,
    );
    for (final star in truth) {
      _addGaussianStar(goodBuilder, star.x, star.y, star.peak, 1.3);
    }
    final InMemoryRgbTileStore goodStore = goodBuilder.build();

    final RecordingRgbTileStoreFactory outputFactory =
        RecordingRgbTileStoreFactory();
    final MilkyWayPipelineResult result = await registerAndCombineDecodedFrames(
      sourcePaths: <String>['ref.arw', 'bad.arw', 'good.arw'],
      frameStores: <LinearRgbTileStore?>[referenceStore, badStore, goodStore],
      decodeFailures: const <int, Object?>{},
      outputTileStoreFactory: outputFactory.call,
      tileSize: 512,
      minRegisteredFrames: 2,
    );

    expect(result.frameDiagnostics[0].included, isTrue);
    expect(result.frameDiagnostics[1].included, isFalse);
    expect(
      result.frameDiagnostics[1].excludedReason,
      contains('registration failed'),
    );
    expect(result.frameDiagnostics[2].included, isTrue);
  });

  test(
    '使用可能なフレームがminRegisteredFrames未満だとMilkyWayRegistrationFailedを投げる',
    () async {
      const int width = 60;
      const int height = 60;
      final InMemoryRgbTileStoreBuilder referenceBuilder =
          InMemoryRgbTileStoreBuilder(width, height);
      final InMemoryRgbTileStore referenceStore = referenceBuilder.build();

      await expectLater(
        registerAndCombineDecodedFrames(
          sourcePaths: <String>['only.arw'],
          frameStores: <LinearRgbTileStore?>[referenceStore],
          decodeFailures: const <int, Object?>{},
          outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
        ),
        throwsA(isA<MilkyWayRegistrationFailed>()),
      );
    },
  );

  test('全フレームがデコード失敗だとMilkyWayRegistrationFailedを投げる', () async {
    await expectLater(
      registerAndCombineDecodedFrames(
        sourcePaths: <String>['a.arw', 'b.arw'],
        frameStores: <LinearRgbTileStore?>[null, null],
        decodeFailures: <int, Object?>{
          0: StateError('broken'),
          1: StateError('broken'),
        },
        outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
      ),
      throwsA(isA<MilkyWayRegistrationFailed>()),
    );
  });

  test('sourcePathsとframeStoresの長さが異なるとArgumentErrorを投げる', () async {
    expect(
      () => registerAndCombineDecodedFrames(
        sourcePaths: <String>['a.arw'],
        frameStores: <LinearRgbTileStore?>[null, null],
        decodeFailures: const <int, Object?>{},
        outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test(
      'registrationWeightはregistrationQualityWeight(rmsResidual)と一致する'
      '(Work56: 均等重みから位置合わせ品質ベースの重みへ変更)', () async {
    const int width = 200;
    const int height = 160;
    const double centerX = width / 2;
    const double centerY = height / 2;
    const double trueRotation = 3.0;
    const double trueDx = 2.5;
    const double trueDy = -1.5;

    final List<({double x, double y, double peak})> truth = _seededStarField(
      24,
      4242,
      width.toDouble(),
      height.toDouble(),
      20,
    );

    final InMemoryRgbTileStoreBuilder referenceBuilder =
        InMemoryRgbTileStoreBuilder(width, height);
    for (final star in truth) {
      _addGaussianStar(referenceBuilder, star.x, star.y, star.peak, 1.3);
    }
    final InMemoryRgbTileStore referenceStore = referenceBuilder.build();

    final InMemoryRgbTileStoreBuilder targetBuilder =
        InMemoryRgbTileStoreBuilder(width, height);
    for (final star in truth) {
      final moved = _rotatePoint(
        star.x,
        star.y,
        trueRotation,
        centerX,
        centerY,
        trueDx,
        trueDy,
      );
      _addGaussianStar(targetBuilder, moved.x, moved.y, star.peak, 1.3);
    }
    final InMemoryRgbTileStore targetStore = targetBuilder.build();

    final MilkyWayPipelineResult result = await registerAndCombineDecodedFrames(
      sourcePaths: <String>['ref.arw', 'target.arw'],
      frameStores: <LinearRgbTileStore?>[referenceStore, targetStore],
      decodeFailures: const <int, Object?>{},
      outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
      tileSize: 512,
      useComprehensiveFrameWeighting: false,
    );

    final MilkyWayFrameDiagnostics referenceDiagnostics =
        result.frameDiagnostics.singleWhere(
      (MilkyWayFrameDiagnostics diagnostics) => diagnostics.rmsResidual == 0,
    );
    final MilkyWayFrameDiagnostics targetDiagnostics =
        result.frameDiagnostics.singleWhere(
      (MilkyWayFrameDiagnostics diagnostics) => diagnostics.rmsResidual != 0,
    );

    // 基準フレームは rmsResidual=0 (構造上、完全な一致) なので重みは
    // ちょうど1のはず。
    expect(referenceDiagnostics.registrationWeight, 1.0);

    // 対象フレームの重みは、実際の rmsResidual を
    // registrationQualityWeight に通した値と厳密に一致するはず
    // (デフォルトの residualHalfWeightRadius=1.5, minimumWeight=0.05)。
    final double expectedWeight = registrationQualityWeight(
      targetDiagnostics.rmsResidual!,
    );
    expect(
      (targetDiagnostics.registrationWeight! - expectedWeight).abs(),
      lessThan(1e-9),
    );
    // 位置合わせがほぼ完璧な合成データなので、重みは1に近いはず
    // (均等重みだった以前のバージョンと区別がつく、ゼロでない実質的な
    // 検証にするため)。
    expect(targetDiagnostics.registrationWeight, greaterThan(0.9));
  });

  test(
      'interpolation: bicubic を指定しても位置合わせ・合成が正常に完了する'
      '(Work57: 高精度リサンプリングオプションの配線確認)', () async {
    const int width = 150;
    const int height = 120;
    final List<({double x, double y, double peak})> truth = _seededStarField(
      20,
      777,
      width.toDouble(),
      height.toDouble(),
      15,
    );
    final InMemoryRgbTileStoreBuilder referenceBuilder =
        InMemoryRgbTileStoreBuilder(width, height);
    for (final star in truth) {
      _addGaussianStar(referenceBuilder, star.x, star.y, star.peak, 1.3);
    }
    final InMemoryRgbTileStore referenceStore = referenceBuilder.build();

    final InMemoryRgbTileStoreBuilder targetBuilder =
        InMemoryRgbTileStoreBuilder(width, height);
    for (final star in truth) {
      final moved = _rotatePoint(
        star.x,
        star.y,
        2.0,
        width / 2,
        height / 2,
        1.0,
        0.5,
      );
      _addGaussianStar(targetBuilder, moved.x, moved.y, star.peak, 1.3);
    }
    final InMemoryRgbTileStore targetStore = targetBuilder.build();

    final MilkyWayPipelineResult result = await registerAndCombineDecodedFrames(
      sourcePaths: <String>['ref.arw', 'target.arw'],
      frameStores: <LinearRgbTileStore?>[referenceStore, targetStore],
      decodeFailures: const <int, Object?>{},
      outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
      tileSize: 512,
      interpolation: ResamplingInterpolation.bicubic,
    );

    expect(result.frameDiagnostics[0].included, isTrue);
    expect(result.frameDiagnostics[1].included, isTrue);
    final RecordingRgbTileStore recorded =
        result.tileStore as RecordingRgbTileStore;
    expect(recorded.isCommitted, isTrue);
    for (final tile in recorded.writtenTiles) {
      for (final double value in tile.interleavedRgb) {
        expect(value.isFinite, isTrue);
      }
    }
  });

  test(
      'runMilkyWayPipeline: masterDarkとdarkFramePathsを同時に指定すると'
      'ArgumentErrorを投げる(Work110)', () async {
    final MilkyWayFrameDecodingConfig decodingConfig =
        MilkyWayFrameDecodingConfig(
      decoderRegistry: RawDecoderRegistry(const <RawDecoder>[]),
    );
    final LinearRawMosaic fakeMasterDark = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List(4),
    );
    await expectLater(
      runMilkyWayPipeline(
        sourcePaths: <String>['a.arw', 'b.arw'],
        decodingConfig: decodingConfig,
        outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
        masterDark: fakeMasterDark,
        darkFramePaths: const <String>['dark0.arw'],
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test(
      'runMilkyWayPipeline: masterFlatとflatFramePathsを同時に指定すると'
      'ArgumentErrorを投げる(Work110)', () async {
    final MilkyWayFrameDecodingConfig decodingConfig =
        MilkyWayFrameDecodingConfig(
      decoderRegistry: RawDecoderRegistry(const <RawDecoder>[]),
    );
    final LinearRawMosaic fakeMasterFlat = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[1, 1, 1, 1]),
    );
    await expectLater(
      runMilkyWayPipeline(
        sourcePaths: <String>['a.arw', 'b.arw'],
        decodingConfig: decodingConfig,
        outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
        masterFlat: fakeMasterFlat,
        flatFramePaths: const <String>['flat0.arw'],
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test('Work250: decoded frame geometry mismatch fails before registration',
      () async {
    final InMemoryRgbTileStoreBuilder first =
        InMemoryRgbTileStoreBuilder(32, 24);
    final InMemoryRgbTileStoreBuilder second =
        InMemoryRgbTileStoreBuilder(31, 24);

    await expectLater(
      registerAndCombineDecodedFrames(
        sourcePaths: const <String>['full.arw', 'crop.arw'],
        frameStores: <LinearRgbTileStore?>[first.build(), second.build()],
        decodeFailures: const <int, Object?>{},
        outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
      ),
      throwsA(
        isA<StateError>().having(
          (StateError error) => error.message.toString(),
          'message',
          contains('Decoded frame dimension mismatch'),
        ),
      ),
    );
  });

  test(
      'Work250: cancellation during registration star preparation propagates as cancellation',
      () async {
    final InMemoryRgbTileStoreBuilder first =
        InMemoryRgbTileStoreBuilder(32, 24);
    final InMemoryRgbTileStoreBuilder second =
        InMemoryRgbTileStoreBuilder(32, 24);

    await expectLater(
      registerAndCombineDecodedFrames(
        sourcePaths: const <String>['a.arw', 'b.arw'],
        frameStores: <LinearRgbTileStore?>[first.build(), second.build()],
        decodeFailures: const <int, Object?>{},
        outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
        isCancelled: () => true,
      ),
      throwsA(isA<TiledStackingCancelled>()),
    );
  });
}
