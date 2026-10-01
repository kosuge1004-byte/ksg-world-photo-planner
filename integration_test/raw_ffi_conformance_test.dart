import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile_stack/core/demosaic/demosaic_request.dart';
import 'package:mobile_stack/core/demosaic/mobile_stack_adaptive_demosaic_engine.dart';
import 'package:mobile_stack/core/demosaic/native_mobile_stack_demosaic_engine.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';
import 'package:mobile_stack/core/quality/processing_precision.dart';
import 'package:mobile_stack/core/raw/ffi_raw_native_bridge.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('ABI適合スタブから決定論的FP32モザイクを取得する', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeDecodedFrame frame = bridge.decode(
        _command(maximumPixelCount: 4),
      );

      expect(frame.width, 2);
      expect(frame.height, 2);
      expect(
        frame.samples,
        orderedEquals(<double>[64, 1024, 2048, 4095]),
      );
      expect(frame.activeArea.width, 2);
      expect(frame.whiteLevel, 4095);
    } finally {
      bridge.close();
    }
  });

  testWidgets('ABI適合スタブが画素上限を明示的に拒否する', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      expect(
        () => bridge.decode(_command(maximumPixelCount: 3)),
        throwsA(
          isA<RawDecodeFailure>().having(
            (RawDecodeFailure error) => error.code,
            'code',
            RawDecodeErrorCode.resourceLimit,
          ),
        ),
      );
    } finally {
      bridge.close();
    }
  });

  testWidgets('通常パスを実デコーダー成功として扱わない', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      expect(
        () => bridge.decode(
          RawNativeDecodeCommand(
            path: '/not/a/production/decoder.dng',
            expectedFormat: RawFormat.dng,
            expectedByteLength: 4,
            outputPrecision: ProcessingPrecision.float32,
            maximumPixelCount: 4,
          ),
        ),
        throwsA(
          isA<RawDecodeFailure>().having(
            (RawDecodeFailure error) => error.code,
            'code',
            RawDecodeErrorCode.unsupportedFormat,
          ),
        ),
      );
    } finally {
      bridge.close();
    }
  });

  testWidgets('ABI v1のメタデータ拡張能力を照会できる', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      expect(
        bridge.capabilities & rawNativeCapabilityDecode,
        rawNativeCapabilityDecode,
      );
      expect(
        bridge.capabilities & rawNativeCapabilityMetadataProbe,
        rawNativeCapabilityMetadataProbe,
      );
      expect(
        bridge.capabilities & rawNativeCapabilityArwLosslessJpeg,
        rawNativeCapabilityArwLosslessJpeg,
      );
      expect(
        bridge.capabilities & rawNativeCapabilitySonyArw2,
        rawNativeCapabilitySonyArw2,
      );
      expect(bridge.supportsSonyArw2, isTrue);
      expect(bridge.supportsBroadSonyRaw, isTrue);
      expect(bridge.supportsBroadNikonRaw, isTrue);
      expect(bridge.supportsMetadataProbe, isTrue);
      expect(bridge.supportsProductionArwLossless, isTrue);
    } finally {
      bridge.close();
    }
  });

  testWidgets('実ARW経路で可逆JPEGタイルをFP32 CFAへ展開する', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-arw-');
    final Uint8List bytes = _minimalArwBytes();
    final File file = File(
      '${directory.path}${Platform.pathSeparator}lossless.arw',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      expect(bridge.supportsProductionArwLossless, isTrue);
      final RawNativeDecodedFrame frame = bridge.decode(
        RawNativeDecodeCommand(
          path: file.path,
          expectedFormat: RawFormat.arw,
          expectedByteLength: bytes.length,
          outputPrecision: ProcessingPrecision.float32,
          maximumPixelCount: 4,
        ),
      );

      expect(frame.format, RawFormat.arw);
      expect(frame.width, 2);
      expect(frame.height, 2);
      expect(frame.cfaPattern.name, 'rggb');
      expect(frame.blackLevels, orderedEquals(<double>[512, 512, 512, 512]));
      expect(frame.whiteLevel, 16383);
      expect(
        frame.cameraWhiteBalance,
        orderedEquals(<double>[2, 1, 1, 1.5]),
      );
      expect(
        frame.samples,
        orderedEquals(<double>[8192, 8193, 8191, 8192]),
      );
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('実ARW経路でSony ARW2ブロックを14bit CFAへ展開する', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-arw2-');
    final Uint8List bytes = _minimalArw2Bytes();
    final File file = File(
      '${directory.path}${Platform.pathSeparator}compressed.arw',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      expect(bridge.supportsSonyArw2, isTrue);
      final RawNativeDecodedFrame frame = bridge.decode(
        RawNativeDecodeCommand(
          path: file.path,
          expectedFormat: RawFormat.arw,
          expectedByteLength: bytes.length,
          outputPrecision: ProcessingPrecision.float32,
          maximumPixelCount: 64,
        ),
      );
      expect(frame.width, 32);
      expect(frame.height, 2);
      expect(frame.blackLevels, orderedEquals(<double>[512, 512, 512, 512]));
      expect(frame.whiteLevel, 16380);
      expect(
          frame.samples.take(32),
          orderedEquals(<double>[
            104,
            104,
            108,
            108,
            400,
            400,
            116,
            116,
            120,
            120,
            124,
            124,
            128,
            128,
            132,
            132,
            136,
            136,
            100,
            100,
            144,
            144,
            148,
            148,
            152,
            152,
            156,
            156,
            160,
            160,
            164,
            164,
          ]));
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('本番パイプライン用ネイティブ適応デモザイクをFFI実行する', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Float32List samples = Float32List(16 * 16);
    for (int y = 0; y < 16; y++) {
      for (int x = 0; x < 16; x++) {
        samples[y * 16 + x] = 0.1 + x / 32 + y / 64;
      }
    }
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: 16,
      height: 16,
      cfaPattern: CfaPattern.rggb,
      samples: samples,
    );
    final OverlappedTile tile = OverlappedTilePlan.create(
      imageWidth: 16,
      imageHeight: 16,
      tileSize: 16,
      overlap: 4,
    ).tiles.single;
    final NativeMobileStackDemosaicEngine engine =
        NativeMobileStackDemosaicEngine();
    try {
      expect(engine.isProductionQuality, isTrue);
      final result = await engine.processTile(
        DemosaicRequest(mosaic: mosaic, tile: tile),
      );
      expect(result.width, 16);
      expect(result.height, 16);
      expect(result.interleavedRgb, hasLength(16 * 16 * 3));
      expect(result.interleavedRgb.every((double value) => value.isFinite),
          isTrue);
    } finally {
      engine.disposeTransientResources();
    }
  });

  testWidgets('ネイティブ適応デモザイクがDart数式参照と全CFAパターンで一致する', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    const int width = 24;
    const int height = 20;
    final OverlappedTile tile = OverlappedTilePlan.create(
      imageWidth: width,
      imageHeight: height,
      tileSize: width,
      overlap: MobileStackAdaptiveDemosaicEngine.referenceRequiredInputRadius,
    ).tiles.single;
    final NativeMobileStackDemosaicEngine nativeEngine =
        NativeMobileStackDemosaicEngine();
    const MobileStackAdaptiveDemosaicEngine dartReference =
        MobileStackAdaptiveDemosaicEngine();
    try {
      for (final CfaPattern pattern in CfaPattern.values) {
        final Float32List samples = Float32List(width * height);
        for (int y = 0; y < height; y++) {
          for (int x = 0; x < width; x++) {
            final double edge = x + 0.7 * y < 18 ? 0.08 : 0.72;
            final double dx = x - 15.3;
            final double dy = y - 7.6;
            final double star = 0.9 / (1 + dx * dx + dy * dy);
            final double texture = ((x * 17 + y * 11) % 9) * 0.002;
            final double colorScale = switch (pattern.colorAt(x, y)) {
              CfaColor.red => 1.17,
              CfaColor.green => 1.0,
              CfaColor.blue => 0.73,
            };
            samples[y * width + x] = (edge + star + texture) * colorScale;
          }
        }
        final LinearRawMosaic mosaic = LinearRawMosaic(
          width: width,
          height: height,
          cfaPattern: pattern,
          samples: samples,
          saturationMask: RawSaturationMask.fromPredicate(
            width * height,
            (int index) => index == 6 * width + 8 || index == 11 * width + 15,
          ),
        );
        final dartResult = await dartReference.processTile(
          DemosaicRequest(mosaic: mosaic, tile: tile),
        );
        final nativeResult = await nativeEngine.processTile(
          DemosaicRequest(mosaic: mosaic, tile: tile),
        );
        expect(nativeResult.interleavedRgb.length,
            dartResult.interleavedRgb.length);
        double maximumDifference = 0;
        for (int i = 0; i < dartResult.interleavedRgb.length; i++) {
          final double difference =
              (nativeResult.interleavedRgb[i] - dartResult.interleavedRgb[i])
                  .abs();
          if (difference > maximumDifference) maximumDifference = difference;
        }
        expect(
          maximumDifference,
          lessThan(2e-6),
          reason: 'native/Dart demosaic mismatch for ${pattern.name}',
        );
      }
    } finally {
      nativeEngine.disposeTransientResources();
    }
  });

  testWidgets('画素バッファなしで決定論的RAWメタデータを取得する', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeMetadataFrame frame = bridge.probeMetadata(
        _metadataCommand(),
      );

      expect(frame.width, 6000);
      expect(frame.height, 4000);
      expect(frame.activeArea.left, 8);
      expect(frame.activeArea.width, 5984);
      expect(frame.whiteLevel, 16383);
      expect(
        frame.cameraWhiteBalance,
        orderedEquals(<double>[2, 1, 1, 1.5]),
      );
      expect(
        frame.d65XyzToCamera,
        orderedEquals(<double>[
          1,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          1,
        ]),
      );
    } finally {
      bridge.close();
    }
  });

  testWidgets('実ファイル経路から最小DNGメタデータだけを取得する', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-dng-');
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      expect(bridge.supportsProductionDngMetadata, isTrue);
      final Map<String, Endian> endianCases = <String, Endian>{
        'little': Endian.little,
        'big': Endian.big,
      };
      for (final MapEntry<String, Endian> endianCase in endianCases.entries) {
        final Uint8List bytes = _minimalDngBytes(endianCase.value);
        final File file = File(
          '${directory.path}${Platform.pathSeparator}'
          '${endianCase.key}.dng',
        );
        await file.writeAsBytes(bytes, flush: true);

        final RawNativeMetadataFrame frame = bridge.probeMetadata(
          RawNativeMetadataProbeCommand(
            path: file.path,
            expectedFormat: RawFormat.dng,
            expectedByteLength: bytes.length,
          ),
        );

        expect(frame.width, 6000);
        expect(frame.height, 4000);
        expect(frame.activeArea.left, 8);
        expect(frame.activeArea.top, 8);
        expect(frame.activeArea.width, 5984);
        expect(frame.activeArea.height, 3984);
        expect(frame.whiteLevel, 16383);
        expect(
          frame.cameraWhiteBalance,
          orderedEquals(<double>[2, 1, 1, 1.5]),
        );
      }
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('DNGの外部値オフセットが範囲外なら拒否する', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-dng-bad-');
    final Uint8List bytes = _minimalDngBytes(
      Endian.little,
      activeAreaValueOffset: 0xFFFFFFF0,
    );
    final File file = File(
      '${directory.path}${Platform.pathSeparator}bad-offset.dng',
    );
    await file.writeAsBytes(bytes, flush: true);

    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      expect(
        () => bridge.probeMetadata(
          RawNativeMetadataProbeCommand(
            path: file.path,
            expectedFormat: RawFormat.dng,
            expectedByteLength: bytes.length,
          ),
        ),
        throwsA(
          isA<RawDecodeFailure>().having(
            (RawDecodeFailure error) => error.code,
            'code',
            RawDecodeErrorCode.corruptData,
          ),
        ),
      );
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('存在しないDNGパスを成功として扱わない', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      expect(
        () => bridge.probeMetadata(
          const RawNativeMetadataProbeCommand(
            path: '/not/a/production/decoder.dng',
            expectedFormat: RawFormat.dng,
            expectedByteLength: 4,
          ),
        ),
        throwsA(
          isA<RawDecodeFailure>().having(
            (RawDecodeFailure error) => error.code,
            'code',
            RawDecodeErrorCode.fileIo,
          ),
        ),
      );
    } finally {
      bridge.close();
    }
  });

  testWidgets('D50 DNG color matrix is adapted to D65 across FFI', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-dng-d50-');
    final Uint8List bytes = _minimalDngBytes(
      Endian.little,
      includeD50ColorMatrix: true,
    );
    final File file = File(
      '${directory.path}${Platform.pathSeparator}d50.dng',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeMetadataFrame frame = bridge.probeMetadata(
        RawNativeMetadataProbeCommand(
          path: file.path,
          expectedFormat: RawFormat.dng,
          expectedByteLength: bytes.length,
        ),
      );
      expect(frame.d65XyzToCamera, isNotNull);
      final List<double> matrix = frame.d65XyzToCamera!;
      expect(matrix[0], closeTo(1.0478, 0.001));
      expect(matrix[1], closeTo(0.0229, 0.001));
      expect(matrix[2], closeTo(-0.0501, 0.001));
      expect(matrix[4], closeTo(0.9905, 0.001));
      expect(matrix[8], closeTo(0.7521, 0.001));
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('dual-illuminant DNG recovers CameraNeutral across FFI', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-dng-dual-',
    );
    final Uint8List bytes = _minimalDngBytes(
      Endian.little,
      includeDualColorMatrices: true,
    );
    final File file = File(
      '${directory.path}${Platform.pathSeparator}dual.dng',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeMetadataFrame frame = bridge.probeMetadata(
        RawNativeMetadataProbeCommand(
          path: file.path,
          expectedFormat: RawFormat.dng,
          expectedByteLength: bytes.length,
        ),
      );
      final List<double> matrix = frame.d65XyzToCamera!;
      const List<double> d65 = <double>[
        0.3127 / 0.3290,
        1,
        (1 - 0.3127 - 0.3290) / 0.3290,
      ];
      final double red =
          matrix[0] * d65[0] + matrix[1] * d65[1] + matrix[2] * d65[2];
      final double green =
          matrix[3] * d65[0] + matrix[4] * d65[1] + matrix[5] * d65[2];
      final double blue =
          matrix[6] * d65[0] + matrix[7] * d65[1] + matrix[8] * d65[2];
      expect(red / green, closeTo(0.5, 0.00001));
      expect(blue / green, closeTo(2 / 3, 0.00001));
      expect(matrix[0], isNot(closeTo(1, 0.01)));
      expect(matrix[0], isNot(closeTo(2, 0.01)));
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('AsShotWhiteXY derives camera white balance across FFI', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-dng-white-xy-',
    );
    final Uint8List bytes = _minimalDngBytes(
      Endian.little,
      includeD50ColorMatrix: true,
      useAsShotWhiteXY: true,
    );
    final File file = File(
      '${directory.path}${Platform.pathSeparator}white-xy.dng',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeMetadataFrame frame = bridge.probeMetadata(
        RawNativeMetadataProbeCommand(
          path: file.path,
          expectedFormat: RawFormat.dng,
          expectedByteLength: bytes.length,
        ),
      );
      final List<double> matrix = frame.d65XyzToCamera!;
      final List<double> gains = frame.cameraWhiteBalance!;
      const List<double> d65 = <double>[
        0.3127 / 0.3290,
        1,
        (1 - 0.3127 - 0.3290) / 0.3290,
      ];
      final List<double> neutral = <double>[
        matrix[0] * d65[0] + matrix[1] * d65[1] + matrix[2] * d65[2],
        matrix[3] * d65[0] + matrix[4] * d65[1] + matrix[5] * d65[2],
        matrix[6] * d65[0] + matrix[7] * d65[1] + matrix[8] * d65[2],
      ];
      final double maximum = neutral.reduce(
        (double left, double right) => left > right ? left : right,
      );
      expect(gains[0], closeTo(maximum / neutral[0], 0.00001));
      expect(gains[1], closeTo(maximum / neutral[1], 0.00001));
      expect(gains[3], closeTo(maximum / neutral[2], 0.00001));
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('Other illuminant xy drives dual interpolation across FFI', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-dng-other-light-',
    );
    final Uint8List bytes = _minimalDngBytes(
      Endian.little,
      includeDualColorMatrices: true,
      includeOtherIlluminants: true,
    );
    final File file = File(
      '${directory.path}${Platform.pathSeparator}other-light.dng',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeMetadataFrame frame = bridge.probeMetadata(
        RawNativeMetadataProbeCommand(
          path: file.path,
          expectedFormat: RawFormat.dng,
          expectedByteLength: bytes.length,
        ),
      );
      final List<double> matrix = frame.d65XyzToCamera!;
      const List<double> d65 = <double>[
        0.3127 / 0.3290,
        1,
        (1 - 0.3127 - 0.3290) / 0.3290,
      ];
      final double red =
          matrix[0] * d65[0] + matrix[1] * d65[1] + matrix[2] * d65[2];
      final double green =
          matrix[3] * d65[0] + matrix[4] * d65[1] + matrix[5] * d65[2];
      final double blue =
          matrix[6] * d65[0] + matrix[7] * d65[1] + matrix[8] * d65[2];
      expect(red / green, closeTo(0.5, 0.00001));
      expect(blue / green, closeTo(2 / 3, 0.00001));
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('spectral illuminant drives dual interpolation across FFI', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-dng-spectral-light-',
    );
    final Uint8List bytes = _minimalDngBytes(
      Endian.little,
      includeDualColorMatrices: true,
      includeOtherIlluminants: true,
      useSpectralIlluminant1: true,
    );
    final File file = File(
      '${directory.path}${Platform.pathSeparator}spectral-light.dng',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeMetadataFrame frame = bridge.probeMetadata(
        RawNativeMetadataProbeCommand(
          path: file.path,
          expectedFormat: RawFormat.dng,
          expectedByteLength: bytes.length,
        ),
      );
      final List<double> matrix = frame.d65XyzToCamera!;
      expect(matrix[0], greaterThan(1));
      expect(matrix[0], lessThan(2));
      const List<double> d65 = <double>[
        0.3127 / 0.3290,
        1,
        (1 - 0.3127 - 0.3290) / 0.3290,
      ];
      final double red =
          matrix[0] * d65[0] + matrix[1] * d65[1] + matrix[2] * d65[2];
      final double green =
          matrix[3] * d65[0] + matrix[4] * d65[1] + matrix[5] * d65[2];
      final double blue =
          matrix[6] * d65[0] + matrix[7] * d65[1] + matrix[8] * d65[2];
      expect(red / green, closeTo(0.5, 0.00001));
      expect(blue / green, closeTo(2 / 3, 0.00001));
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('triple-illuminant profile selects custom third light via FFI', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-dng-triple-light-',
    );
    final Uint8List bytes = _tripleIlluminantDngBytes();
    final File file = File(
      '${directory.path}${Platform.pathSeparator}triple-light.dng',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeMetadataFrame frame = bridge.probeMetadata(
        RawNativeMetadataProbeCommand(
          path: file.path,
          expectedFormat: RawFormat.dng,
          expectedByteLength: bytes.length,
        ),
      );
      expect(frame.d65XyzToCamera, isNotNull);
      final List<double> gains = frame.cameraWhiteBalance!;
      expect(gains[0], closeTo(1, 0.00001));
      expect(gains[1], closeTo(3.8, 0.00002));
      expect(gains[3], closeTo(3.5625, 0.00002));
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('BaselineExposure is preserved in the optional ABI tail', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-dng-baseline-exposure-',
    );
    final Uint8List bytes = _baselineExposureDngBytes();
    final File file = File(
      '${directory.path}${Platform.pathSeparator}baseline-exposure.dng',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeMetadataFrame frame = bridge.probeMetadata(
        RawNativeMetadataProbeCommand(
          path: file.path,
          expectedFormat: RawFormat.dng,
          expectedByteLength: bytes.length,
        ),
      );
      expect(frame.baselineExposure, closeTo(0.5, 0.000001));
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('BaselineExposureOffset is preserved separately and summed', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-dng-baseline-exposure-offset-',
    );
    final Uint8List bytes = _baselineExposureOffsetDngBytes();
    final File file = File(
      '${directory.path}${Platform.pathSeparator}baseline-exposure-offset.dng',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeMetadataFrame frame = bridge.probeMetadata(
        RawNativeMetadataProbeCommand(
          path: file.path,
          expectedFormat: RawFormat.dng,
          expectedByteLength: bytes.length,
        ),
      );
      expect(frame.baselineExposure, closeTo(0.5, 0.000001));
      expect(frame.baselineExposureOffset, closeTo(-0.25, 0.000001));
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('ProfileToneCurve is copied before native result release', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-dng-profile-tone-curve-',
    );
    final Uint8List bytes = _profileToneCurveDngBytes();
    final File file = File(
      '${directory.path}${Platform.pathSeparator}profile-tone-curve.dng',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeMetadataFrame frame = bridge.probeMetadata(
        RawNativeMetadataProbeCommand(
          path: file.path,
          expectedFormat: RawFormat.dng,
          expectedByteLength: bytes.length,
        ),
      );
      expect(
        frame.profileToneCurve,
        orderedEquals(<double>[0, 0, 0.5, 0.25, 1, 1]),
      );
      expect(frame.profileToneCurve, isA<List<double>>());
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('ProfileHueSatMap is copied before native result release', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-dng-profile-hue-sat-map-',
    );
    final Uint8List bytes = _profileHueSatMapDngBytes();
    final File file = File(
      '${directory.path}${Platform.pathSeparator}profile-hue-sat-map.dng',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeMetadataFrame frame = bridge.probeMetadata(
        RawNativeMetadataProbeCommand(
          path: file.path,
          expectedFormat: RawFormat.dng,
          expectedByteLength: bytes.length,
        ),
      );
      final RawProfileHueSatMap map = frame.profileHueSatMap!;
      expect(map.hueDivisions, 2);
      expect(map.saturationDivisions, 2);
      expect(map.valueDivisions, 1);
      expect(map.entryCount, 4);
      expect(map.deltas[3], 10);
      expect(map.deltas[10], closeTo(0.8, 0.000001));
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });

  testWidgets('ProfileLookTable is copied before native result release', (
    WidgetTester tester,
  ) async {
    if (!Platform.isAndroid && !Platform.isIOS) return;
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-dng-profile-look-table-',
    );
    final Uint8List bytes = _profileLookTableDngBytes();
    final File file = File(
      '${directory.path}${Platform.pathSeparator}profile-look-table.dng',
    );
    await file.writeAsBytes(bytes, flush: true);
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      final RawNativeMetadataFrame frame = bridge.probeMetadata(
        RawNativeMetadataProbeCommand(
          path: file.path,
          expectedFormat: RawFormat.dng,
          expectedByteLength: bytes.length,
        ),
      );
      final RawProfileLookTable table = frame.profileLookTable!;
      expect(table.hueDivisions, 2);
      expect(table.saturationDivisions, 2);
      expect(table.valueDivisions, 1);
      expect(table.entryCount, 4);
      expect(table.deltas[3], 20);
      expect(table.deltas[10], closeTo(0.8, 0.000001));
    } finally {
      bridge.close();
      await directory.delete(recursive: true);
    }
  });
}

RawNativeDecodeCommand _command({
  required int maximumPixelCount,
}) {
  return RawNativeDecodeCommand(
    path: 'mobile-stack-abi://success',
    expectedFormat: RawFormat.dng,
    expectedByteLength: 4,
    outputPrecision: ProcessingPrecision.float32,
    maximumPixelCount: maximumPixelCount,
  );
}

RawNativeMetadataProbeCommand _metadataCommand() {
  return const RawNativeMetadataProbeCommand(
    path: 'mobile-stack-abi://metadata',
    expectedFormat: RawFormat.dng,
    expectedByteLength: 4,
  );
}

Uint8List _minimalDngBytes(
  Endian endian, {
  int? activeAreaValueOffset,
  bool includeD50ColorMatrix = false,
  bool includeDualColorMatrices = false,
  bool useAsShotWhiteXY = false,
  bool includeOtherIlluminants = false,
  bool useSpectralIlluminant1 = false,
}) {
  assert(!(includeD50ColorMatrix && includeDualColorMatrices));
  assert(!includeOtherIlluminants || includeDualColorMatrices);
  assert(!useSpectralIlluminant1 || includeOtherIlluminants);
  final int entryCount = includeOtherIlluminants
      ? 21
      : (includeDualColorMatrices ? 19 : (includeD50ColorMatrix ? 17 : 15));
  final int blackOffset = 14 + entryCount * 12;
  final int neutralOffset = blackOffset + 8;
  final int activeOffset = neutralOffset + 24;
  final int colorMatrixOffset = activeOffset + 16;
  final int colorMatrix2Offset = colorMatrixOffset + 72;
  final int illuminantData1Offset = colorMatrix2Offset + 72;
  final int illuminantData1Length = useSpectralIlluminant1 ? 38 : 18;
  final int illuminantData2Offset =
      illuminantData1Offset + illuminantData1Length;
  final int fileLength = includeOtherIlluminants
      ? illuminantData2Offset + 18
      : (includeDualColorMatrices
          ? colorMatrix2Offset + 72
          : (includeD50ColorMatrix
              ? colorMatrixOffset + 72
              : activeOffset + 16));
  final Uint8List bytes = Uint8List(fileLength);
  final ByteData data = ByteData.sublistView(bytes);

  void uint16(int offset, int value) {
    data.setUint16(offset, value, endian);
  }

  void uint32(int offset, int value) {
    data.setUint32(offset, value, endian);
  }

  int entryOffset(int index) => 10 + index * 12;

  void entryHeader(
    int index,
    int tag,
    int type,
    int count,
  ) {
    final int offset = entryOffset(index);
    uint16(offset, tag);
    uint16(offset + 2, type);
    uint32(offset + 4, count);
  }

  void longEntry(int index, int tag, int value) {
    final int offset = entryOffset(index);
    entryHeader(index, tag, 4, 1);
    uint32(offset + 8, value);
  }

  void shortEntry(int index, int tag, int value) {
    final int offset = entryOffset(index);
    entryHeader(index, tag, 3, 1);
    uint16(offset + 8, value);
  }

  void shortPairEntry(int index, int tag, int first, int second) {
    final int offset = entryOffset(index);
    entryHeader(index, tag, 3, 2);
    uint16(offset + 8, first);
    uint16(offset + 10, second);
  }

  void byteFourEntry(
    int index,
    int tag,
    int first,
    int second,
    int third,
    int fourth,
  ) {
    final int offset = entryOffset(index);
    entryHeader(index, tag, 1, 4);
    bytes[offset + 8] = first;
    bytes[offset + 9] = second;
    bytes[offset + 10] = third;
    bytes[offset + 11] = fourth;
  }

  void offsetEntry(
    int index,
    int tag,
    int type,
    int count,
    int valueOffset,
  ) {
    final int offset = entryOffset(index);
    entryHeader(index, tag, type, count);
    uint32(offset + 8, valueOffset);
  }

  void signedRational(int offset, int numerator, int denominator) {
    data.setInt32(offset, numerator, endian);
    data.setInt32(offset + 4, denominator, endian);
  }

  bytes[0] = endian == Endian.little ? 0x49 : 0x4D;
  bytes[1] = bytes[0];
  uint16(2, 42);
  uint32(4, 8);
  uint16(8, entryCount);
  longEntry(0, 254, 0);
  longEntry(1, 256, 6000);
  longEntry(2, 257, 4000);
  shortEntry(3, 258, 16);
  shortEntry(4, 262, 32803);
  shortEntry(5, 274, 1);
  shortEntry(6, 277, 1);
  shortPairEntry(7, 33421, 2, 2);
  byteFourEntry(8, 33422, 0, 1, 1, 2);
  byteFourEntry(9, 50706, 1, 4, 0, 0);
  shortPairEntry(10, 50713, 2, 2);
  offsetEntry(11, 50714, 3, 4, blackOffset);
  longEntry(12, 50717, 16383);
  offsetEntry(
    13,
    useAsShotWhiteXY ? 50729 : 50728,
    5,
    useAsShotWhiteXY ? 2 : 3,
    neutralOffset,
  );
  offsetEntry(
    14,
    50829,
    4,
    4,
    activeAreaValueOffset ?? activeOffset,
  );
  if (includeD50ColorMatrix) {
    offsetEntry(15, 50721, 10, 9, colorMatrixOffset);
    shortEntry(16, 50778, 23);
  } else if (includeDualColorMatrices) {
    offsetEntry(15, 50721, 10, 9, colorMatrixOffset);
    offsetEntry(16, 50722, 10, 9, colorMatrix2Offset);
    shortEntry(17, 50778, includeOtherIlluminants ? 255 : 17);
    shortEntry(18, 50779, includeOtherIlluminants ? 255 : 21);
    if (includeOtherIlluminants) {
      offsetEntry(
        19,
        52533,
        7,
        illuminantData1Length,
        illuminantData1Offset,
      );
      offsetEntry(20, 52534, 7, 18, illuminantData2Offset);
    }
  }
  uint32(10 + entryCount * 12, 0);

  for (int index = 0; index < 4; index++) {
    uint16(blackOffset + index * 2, 64);
  }
  if (useAsShotWhiteXY) {
    uint32(neutralOffset, 3457);
    uint32(neutralOffset + 4, 10000);
    uint32(neutralOffset + 8, 3585);
    uint32(neutralOffset + 12, 10000);
  } else {
    uint32(neutralOffset, 1);
    uint32(neutralOffset + 4, 2);
    uint32(neutralOffset + 8, 1);
    uint32(neutralOffset + 12, 1);
    uint32(neutralOffset + 16, 2);
    uint32(neutralOffset + 20, 3);
  }
  uint32(activeOffset, 8);
  uint32(activeOffset + 4, 8);
  uint32(activeOffset + 8, 3992);
  uint32(activeOffset + 12, 5992);
  if (includeD50ColorMatrix) {
    for (int index = 0; index < 9; index++) {
      signedRational(
        colorMatrixOffset + index * 8,
        index == 0 || index == 4 || index == 8 ? 1 : 0,
        1,
      );
    }
  } else if (includeDualColorMatrices) {
    for (int index = 0; index < 9; index++) {
      signedRational(
        colorMatrixOffset + index * 8,
        index == 0 || index == 4 || index == 8 ? 1 : 0,
        1,
      );
      signedRational(
        colorMatrix2Offset + index * 8,
        index == 0 ? 2 : (index == 4 || index == 8 ? 1 : 0),
        1,
      );
    }
    if (includeOtherIlluminants) {
      void illuminantData(int offset, int xNumerator, int yNumerator) {
        uint16(offset, 0);
        uint32(offset + 2, xNumerator);
        uint32(offset + 6, 10000);
        uint32(offset + 10, yNumerator);
        uint32(offset + 14, 10000);
      }

      if (useSpectralIlluminant1) {
        uint16(illuminantData1Offset, 1);
        uint32(illuminantData1Offset + 2, 2);
        uint32(illuminantData1Offset + 6, 360);
        uint32(illuminantData1Offset + 10, 1);
        uint32(illuminantData1Offset + 14, 470);
        uint32(illuminantData1Offset + 18, 1);
        uint32(illuminantData1Offset + 22, 1);
        uint32(illuminantData1Offset + 26, 1);
        uint32(illuminantData1Offset + 30, 1);
        uint32(illuminantData1Offset + 34, 1);
      } else {
        illuminantData(illuminantData1Offset, 4476, 4074);
      }
      illuminantData(illuminantData2Offset, 3127, 3290);
    }
  }
  return bytes;
}

Uint8List _tripleIlluminantDngBytes() {
  const Endian endian = Endian.little;
  const int ifdOffset = 8;
  const int entryCount = 22;
  const int blackOffset = 278;
  const int whiteOffset = 286;
  const int activeOffset = 310;
  const int matrix1Offset = 326;
  const int matrix2Offset = 398;
  const int matrix3Offset = 470;
  const int illuminant3DataOffset = 542;
  final Uint8List bytes = Uint8List(560);
  final ByteData data = ByteData.sublistView(bytes);

  void uint16(int offset, int value) => data.setUint16(offset, value, endian);
  void uint32(int offset, int value) => data.setUint32(offset, value, endian);
  int entryOffset(int index) => ifdOffset + 2 + index * 12;
  void entry(int index, int tag, int type, int count, int value) {
    final int offset = entryOffset(index);
    uint16(offset, tag);
    uint16(offset + 2, type);
    uint32(offset + 4, count);
    uint32(offset + 8, value);
  }

  void shortEntry(int index, int tag, int value) {
    final int offset = entryOffset(index);
    uint16(offset, tag);
    uint16(offset + 2, 3);
    uint32(offset + 4, 1);
    uint16(offset + 8, value);
  }

  void signedRational(int offset, int numerator) {
    data.setInt32(offset, numerator, endian);
    data.setInt32(offset + 4, 1, endian);
  }

  bytes[0] = 0x49;
  bytes[1] = 0x49;
  uint16(2, 42);
  uint32(4, ifdOffset);
  uint16(ifdOffset, entryCount);
  entry(0, 254, 4, 1, 0);
  entry(1, 256, 4, 1, 6000);
  entry(2, 257, 4, 1, 4000);
  shortEntry(3, 258, 16);
  shortEntry(4, 262, 32803);
  shortEntry(5, 274, 1);
  shortEntry(6, 277, 1);
  final int cfaDimensionOffset = entryOffset(7);
  uint16(cfaDimensionOffset, 33421);
  uint16(cfaDimensionOffset + 2, 3);
  uint32(cfaDimensionOffset + 4, 2);
  uint16(cfaDimensionOffset + 8, 2);
  uint16(cfaDimensionOffset + 10, 2);
  final int cfaPatternOffset = entryOffset(8);
  uint16(cfaPatternOffset, 33422);
  uint16(cfaPatternOffset + 2, 1);
  uint32(cfaPatternOffset + 4, 4);
  bytes
      .setRange(cfaPatternOffset + 8, cfaPatternOffset + 12, <int>[0, 1, 1, 2]);
  final int versionOffset = entryOffset(9);
  uint16(versionOffset, 50706);
  uint16(versionOffset + 2, 1);
  uint32(versionOffset + 4, 4);
  bytes.setRange(versionOffset + 8, versionOffset + 12, <int>[1, 6, 0, 0]);
  final int blackDimensionOffset = entryOffset(10);
  uint16(blackDimensionOffset, 50713);
  uint16(blackDimensionOffset + 2, 3);
  uint32(blackDimensionOffset + 4, 2);
  uint16(blackDimensionOffset + 8, 2);
  uint16(blackDimensionOffset + 10, 2);
  entry(11, 50714, 3, 4, blackOffset);
  entry(12, 50717, 4, 1, 16383);
  entry(13, 50729, 5, 2, whiteOffset);
  entry(14, 50829, 4, 4, activeOffset);
  entry(15, 50721, 10, 9, matrix1Offset);
  entry(16, 50722, 10, 9, matrix2Offset);
  entry(17, 52531, 10, 9, matrix3Offset);
  shortEntry(18, 50778, 17);
  shortEntry(19, 50779, 21);
  shortEntry(20, 52529, 255);
  entry(21, 52535, 7, 18, illuminant3DataOffset);
  uint32(274, 0);

  for (int index = 0; index < 4; index++) {
    uint16(blackOffset + index * 2, 64);
  }
  uint32(whiteOffset, 38);
  uint32(whiteOffset + 4, 100);
  uint32(whiteOffset + 8, 30);
  uint32(whiteOffset + 12, 100);
  uint32(activeOffset, 8);
  uint32(activeOffset + 4, 8);
  uint32(activeOffset + 8, 3992);
  uint32(activeOffset + 12, 5992);
  for (int index = 0; index < 9; index++) {
    final bool diagonal = index == 0 || index == 4 || index == 8;
    signedRational(matrix1Offset + index * 8, diagonal ? 1 : 0);
    signedRational(
      matrix2Offset + index * 8,
      index == 0 ? 2 : (diagonal ? 1 : 0),
    );
    signedRational(
      matrix3Offset + index * 8,
      index == 0 ? 3 : (diagonal ? 1 : 0),
    );
  }
  uint16(illuminant3DataOffset, 0);
  uint32(illuminant3DataOffset + 2, 38);
  uint32(illuminant3DataOffset + 6, 100);
  uint32(illuminant3DataOffset + 10, 30);
  uint32(illuminant3DataOffset + 14, 100);
  return bytes;
}

Uint8List _baselineExposureDngBytes() {
  final Uint8List base = _minimalDngBytes(Endian.little);
  final Uint8List bytes = Uint8List(base.length + 8)
    ..setRange(0, base.length, base);
  final ByteData data = ByteData.sublistView(bytes);
  const int entryIndex = 5;
  final int entryOffset = 10 + entryIndex * 12;
  data.setUint16(entryOffset, 50730, Endian.little);
  data.setUint16(entryOffset + 2, 10, Endian.little);
  data.setUint32(entryOffset + 4, 1, Endian.little);
  data.setUint32(entryOffset + 8, base.length, Endian.little);
  data.setInt32(base.length, 1, Endian.little);
  data.setInt32(base.length + 4, 2, Endian.little);
  return bytes;
}

Uint8List _baselineExposureOffsetDngBytes() {
  final Uint8List base = _minimalDngBytes(Endian.little);
  final Uint8List bytes = Uint8List(base.length + 16)
    ..setRange(0, base.length, base);
  final ByteData data = ByteData.sublistView(bytes);

  void signedRationalEntry(
    int entryIndex,
    int tag,
    int valueOffset,
    int numerator,
    int denominator,
  ) {
    final int entryOffset = 10 + entryIndex * 12;
    data.setUint16(entryOffset, tag, Endian.little);
    data.setUint16(entryOffset + 2, 10, Endian.little);
    data.setUint32(entryOffset + 4, 1, Endian.little);
    data.setUint32(entryOffset + 8, valueOffset, Endian.little);
    data.setInt32(valueOffset, numerator, Endian.little);
    data.setInt32(valueOffset + 4, denominator, Endian.little);
  }

  signedRationalEntry(5, 50730, base.length, 1, 2);
  signedRationalEntry(6, 51109, base.length + 8, -1, 4);
  return bytes;
}

Uint8List _profileToneCurveDngBytes() {
  final Uint8List base = _minimalDngBytes(Endian.little);
  const List<double> curve = <double>[0, 0, 0.5, 0.25, 1, 1];
  final Uint8List bytes = Uint8List(base.length + curve.length * 4)
    ..setRange(0, base.length, base);
  final ByteData data = ByteData.sublistView(bytes);
  const int entryIndex = 5;
  final int entryOffset = 10 + entryIndex * 12;
  data.setUint16(entryOffset, 50940, Endian.little);
  data.setUint16(entryOffset + 2, 11, Endian.little);
  data.setUint32(entryOffset + 4, curve.length, Endian.little);
  data.setUint32(entryOffset + 8, base.length, Endian.little);
  for (int index = 0; index < curve.length; index++) {
    data.setFloat32(base.length + index * 4, curve[index], Endian.little);
  }
  return bytes;
}

Uint8List _profileHueSatMapDngBytes() {
  final Uint8List base = _minimalDngBytes(
    Endian.little,
    includeD50ColorMatrix: true,
  );
  const List<int> dimensions = <int>[2, 2, 1];
  const List<double> deltas = <double>[
    0,
    1,
    1,
    10,
    1.2,
    0.9,
    0,
    1,
    1,
    -10,
    0.8,
    1.1,
  ];
  final int dimensionsOffset = base.length;
  final int mapOffset = dimensionsOffset + dimensions.length * 4;
  final Uint8List bytes = Uint8List(mapOffset + deltas.length * 4)
    ..setRange(0, base.length, base);
  final ByteData data = ByteData.sublistView(bytes);
  void offsetEntry(int index, int tag, int count, int offset) {
    final int entryOffset = 10 + index * 12;
    data.setUint16(entryOffset, tag, Endian.little);
    data.setUint16(entryOffset + 2, tag == 50937 ? 4 : 11, Endian.little);
    data.setUint32(entryOffset + 4, count, Endian.little);
    data.setUint32(entryOffset + 8, offset, Endian.little);
  }

  offsetEntry(5, 50937, dimensions.length, dimensionsOffset);
  offsetEntry(6, 50938, deltas.length, mapOffset);
  for (int index = 0; index < dimensions.length; index++) {
    data.setUint32(
      dimensionsOffset + index * 4,
      dimensions[index],
      Endian.little,
    );
  }
  for (int index = 0; index < deltas.length; index++) {
    data.setFloat32(mapOffset + index * 4, deltas[index], Endian.little);
  }
  return bytes;
}

Uint8List _profileLookTableDngBytes() {
  final Uint8List base = _minimalDngBytes(
    Endian.little,
    includeD50ColorMatrix: true,
  );
  const List<int> dimensions = <int>[2, 2, 1];
  const List<double> deltas = <double>[
    0,
    1,
    1,
    20,
    1.2,
    0.9,
    0,
    1,
    1,
    -20,
    0.8,
    1.1,
  ];
  final int dimensionsOffset = base.length;
  final int tableOffset = dimensionsOffset + dimensions.length * 4;
  final Uint8List bytes = Uint8List(tableOffset + deltas.length * 4)
    ..setRange(0, base.length, base);
  final ByteData data = ByteData.sublistView(bytes);
  void offsetEntry(int index, int tag, int type, int count, int offset) {
    final int entryOffset = 10 + index * 12;
    data.setUint16(entryOffset, tag, Endian.little);
    data.setUint16(entryOffset + 2, type, Endian.little);
    data.setUint32(entryOffset + 4, count, Endian.little);
    data.setUint32(entryOffset + 8, offset, Endian.little);
  }

  offsetEntry(5, 50981, 4, dimensions.length, dimensionsOffset);
  offsetEntry(6, 50982, 11, deltas.length, tableOffset);
  for (int index = 0; index < dimensions.length; index++) {
    data.setUint32(
      dimensionsOffset + index * 4,
      dimensions[index],
      Endian.little,
    );
  }
  for (int index = 0; index < deltas.length; index++) {
    data.setFloat32(tableOffset + index * 4, deltas[index], Endian.little);
  }
  return bytes;
}

Uint8List _minimalArwBytes() {
  const int ifdOffset = 8;
  const int entryCount = 18;
  const int cropOriginOffset = 240;
  const int cropSizeOffset = 248;
  const int blackOffset = 256;
  const int whiteBalanceOffset = 264;
  const int jpegOffset = 320;
  const List<int> jpeg = <int>[
    0xFF,
    0xD8,
    0xFF,
    0xC3,
    0x00,
    0x14,
    0x0E,
    0x00,
    0x01,
    0x00,
    0x01,
    0x04,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0x04,
    0x11,
    0x00,
    0xFF,
    0xC4,
    0x00,
    0x15,
    0x00,
    0x02,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x01,
    0xFF,
    0xDA,
    0x00,
    0x0E,
    0x04,
    0x01,
    0x00,
    0x02,
    0x00,
    0x03,
    0x00,
    0x04,
    0x00,
    0x01,
    0x00,
    0x00,
    0x73,
    0xFF,
    0xD9,
  ];
  final Uint8List bytes = Uint8List(512);
  final ByteData data = ByteData.sublistView(bytes);
  data.setUint16(0, 0x4949, Endian.big);
  data.setUint16(2, 42, Endian.little);
  data.setUint32(4, ifdOffset, Endian.little);
  data.setUint16(ifdOffset, entryCount, Endian.little);

  void entry(int index, int tag, int type, int count, int value) {
    final int offset = ifdOffset + 2 + index * 12;
    data.setUint16(offset, tag, Endian.little);
    data.setUint16(offset + 2, type, Endian.little);
    data.setUint32(offset + 4, count, Endian.little);
    data.setUint32(offset + 8, value, Endian.little);
  }

  final List<List<int>> entries = <List<int>>[
    <int>[0x0100, 3, 1, 2],
    <int>[0x0101, 3, 1, 2],
    <int>[0x0102, 3, 1, 14],
    <int>[0x0103, 3, 1, 7],
    <int>[0x0106, 3, 1, 32803],
    <int>[0x0112, 3, 1, 1],
    <int>[0x0115, 3, 1, 1],
    <int>[0x0142, 3, 1, 2],
    <int>[0x0143, 3, 1, 2],
    <int>[0x0144, 4, 1, jpegOffset],
    <int>[0x0145, 4, 1, jpeg.length],
    <int>[0x7310, 3, 4, blackOffset],
    <int>[0x7313, 8, 4, whiteBalanceOffset],
    <int>[0x828D, 3, 2, 0x00020002],
    <int>[0x828E, 1, 4, 0x02010100],
    <int>[0xC61D, 3, 1, 16383],
    <int>[0xC61F, 4, 2, cropOriginOffset],
    <int>[0xC620, 4, 2, cropSizeOffset],
  ];
  for (int index = 0; index < entries.length; index++) {
    final List<int> values = entries[index];
    entry(index, values[0], values[1], values[2], values[3]);
  }
  data.setUint32(
    ifdOffset + 2 + entryCount * 12,
    0,
    Endian.little,
  );
  data.setUint32(cropOriginOffset, 0, Endian.little);
  data.setUint32(cropOriginOffset + 4, 0, Endian.little);
  data.setUint32(cropSizeOffset, 2, Endian.little);
  data.setUint32(cropSizeOffset + 4, 2, Endian.little);
  for (int index = 0; index < 4; index++) {
    data.setUint16(blackOffset + index * 2, 512, Endian.little);
  }
  const List<int> whiteBalance = <int>[2048, 1024, 1024, 1536];
  for (int index = 0; index < whiteBalance.length; index++) {
    data.setInt16(
      whiteBalanceOffset + index * 2,
      whiteBalance[index],
      Endian.little,
    );
  }
  bytes.setRange(jpegOffset, jpegOffset + jpeg.length, jpeg);
  return bytes;
}

Uint8List _minimalArw2Bytes() {
  const int ifdOffset = 8;
  const int entryCount = 14;
  const int blackOffset = 256;
  const int stripOffset = 320;
  final Uint8List bytes = Uint8List(512);
  final ByteData data = ByteData.sublistView(bytes);
  data.setUint16(0, 0x4949, Endian.big);
  data.setUint16(2, 42, Endian.little);
  data.setUint32(4, ifdOffset, Endian.little);
  data.setUint16(ifdOffset, entryCount, Endian.little);

  void entry(int index, int tag, int type, int count, int value) {
    final int offset = ifdOffset + 2 + index * 12;
    data.setUint16(offset, tag, Endian.little);
    data.setUint16(offset + 2, type, Endian.little);
    data.setUint32(offset + 4, count, Endian.little);
    data.setUint32(offset + 8, value, Endian.little);
  }

  final List<List<int>> entries = <List<int>>[
    <int>[0x0100, 3, 1, 32],
    <int>[0x0101, 3, 1, 2],
    <int>[0x0102, 3, 1, 12],
    <int>[0x0103, 3, 1, 32767],
    <int>[0x0106, 3, 1, 32803],
    <int>[0x0111, 4, 1, stripOffset],
    <int>[0x0112, 3, 1, 1],
    <int>[0x0115, 3, 1, 1],
    <int>[0x0116, 4, 1, 2],
    <int>[0x0117, 4, 1, 64],
    <int>[0x7310, 3, 4, blackOffset],
    <int>[0x828D, 3, 2, 0x00020002],
    <int>[0x828E, 1, 4, 0x02010100],
    <int>[0xC61D, 3, 1, 16380],
  ];
  for (int index = 0; index < entries.length; index++) {
    final List<int> values = entries[index];
    entry(index, values[0], values[1], values[2], values[3]);
  }
  for (int index = 0; index < 4; index++) {
    data.setUint16(blackOffset + index * 2, 512, Endian.little);
  }

  final Uint8List block = Uint8List(16);
  void bits(int position, int count, int value) {
    for (int bit = 0; bit < count; bit++) {
      block[(position + bit) >> 3] |=
          ((value >> bit) & 1) << ((position + bit) & 7);
    }
  }

  bits(0, 11, 200);
  bits(11, 11, 50);
  bits(22, 4, 2);
  bits(26, 4, 9);
  int position = 30;
  for (int index = 0; index < 16; index++) {
    if (index == 2 || index == 9) continue;
    bits(position, 7, index + 1);
    position += 7;
  }
  bytes.setRange(stripOffset, stripOffset + 16, block);
  bytes.setRange(stripOffset + 16, stripOffset + 32, block);
  bytes.setRange(stripOffset + 32, stripOffset + 48, block);
  bytes.setRange(stripOffset + 48, stripOffset + 64, block);
  return bytes;
}
