import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/demosaic/demosaic_algorithm.dart';
import 'package:mobile_stack/core/demosaic/demosaic_engine.dart';
import 'package:mobile_stack/core/demosaic/demosaic_registry.dart';
import 'package:mobile_stack/core/demosaic/demosaic_request.dart';
import 'package:mobile_stack/core/engine/phase2_validated_job_executor.dart';
import 'package:mobile_stack/core/engine/processing_job.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/core/raw/native_raw_decoder.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_decoder_registry.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_metadata_probe.dart';
import 'package:mobile_stack/core/raw/raw_probe_result.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';

import 'support/recording_rgb_tile_store.dart';

class _RecordingArwBackend implements RawNativeDecodeBackend {
  RawNativeDecodeCommand? command;

  @override
  Future<RawNativeDecodedFrame> decode(
    RawNativeDecodeCommand command,
  ) async {
    this.command = command;
    return RawNativeDecodedFrame(
      format: RawFormat.arw,
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      activeArea: const RawActiveArea(
        left: 0,
        top: 0,
        width: 2,
        height: 2,
      ),
      orientation: 1,
      blackLevels: const <double>[512, 512, 512, 512],
      whiteLevel: 16383,
      cameraWhiteBalance: const <double>[2, 1, 1, 1.5],
      samples: Float32List.fromList(
        <double>[512, 513, 514, 515],
      ),
    );
  }
}

class _TestProductionDemosaic implements DemosaicEngine {
  @override
  DemosaicAlgorithm get algorithm => DemosaicAlgorithm.mobileStackAdaptive;

  @override
  bool get isProductionQuality => true;

  @override
  int get requiredInputRadius => 4;

  @override
  Future<LinearRgbTile> processTile(DemosaicRequest request) async {
    return LinearRgbTile(
      x: request.tile.outputX,
      y: request.tile.outputY,
      width: request.tile.outputWidth,
      height: request.tile.outputHeight,
      interleavedRgb: Float32List.fromList(
        List<double>.filled(
          request.tile.outputWidth * request.tile.outputHeight * 3,
          0.25,
        ),
      ),
    );
  }
}

class _StaticMetadataProbe implements RawMetadataProbe {
  _StaticMetadataProbe(this.metadata);

  final RawFrameMetadata metadata;

  @override
  bool supports(RawFormat format) => format == metadata.format;

  @override
  Future<RawMetadataProbeResult> probe(RawProbeResult source) async =>
      RawMetadataProbeResult(
        width: metadata.activeArea.width,
        height: metadata.activeArea.height,
        cfaPattern: CfaPattern.rggb,
        metadata: metadata,
        probeId: 'test-static-metadata',
      );
}

class _CancellingDemosaic implements DemosaicEngine {
  _CancellingDemosaic(this.onProcess);

  final void Function() onProcess;

  @override
  DemosaicAlgorithm get algorithm => DemosaicAlgorithm.mobileStackAdaptive;

  @override
  bool get isProductionQuality => true;

  @override
  int get requiredInputRadius => 4;

  @override
  Future<LinearRgbTile> processTile(DemosaicRequest request) async {
    onProcess();
    return LinearRgbTile(
      x: request.tile.outputX,
      y: request.tile.outputY,
      width: request.tile.outputWidth,
      height: request.tile.outputHeight,
      interleavedRgb: Float32List.fromList(
        List<double>.filled(
          request.tile.outputWidth * request.tile.outputHeight * 3,
          0.25,
        ),
      ),
    );
  }
}

void main() {
  test('受理済みARWを実デコーダー経由で品質パイプラインへ渡す', () async {
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-phase2-arw-');
    final File file = File(
      '${directory.path}${Platform.pathSeparator}input.arw',
    );
    final Uint8List bytes = Uint8List(32)
      ..[0] = 0x49
      ..[1] = 0x49
      ..[2] = 0x2A
      ..[3] = 0x00;
    await file.writeAsBytes(bytes, flush: true);
    final _RecordingArwBackend backend = _RecordingArwBackend();
    final RawDecoderRegistry registry = RawDecoderRegistry(
      <RawDecoder>[
        NativeRawDecoder(
          backend: backend,
          supportedFormats: const <RawFormat>{RawFormat.arw},
          decoderId: 'test-arw-lossless',
        ),
      ],
    );
    final ProcessingJob job = ProcessingJob(
      id: 'arw-job',
      mode: ProcessingMode.milkyWay,
      sourcePath: file.path,
    );
    final RecordingRgbTileStoreFactory storeFactory =
        RecordingRgbTileStoreFactory();
    try {
      final List<double> progress = <double>[];
      await runPhase2ValidatedJob(
        job,
        progress.add,
        decoderRegistry: registry,
        demosaicRegistry: DemosaicRegistry(
          <DemosaicEngine>[_TestProductionDemosaic()],
        ),
        rgbTileStoreFactory: storeFactory.call,
      );

      expect(backend.command, isNotNull);
      expect(backend.command!.path, file.path);
      expect(backend.command!.expectedFormat, RawFormat.arw);
      expect(backend.command!.expectedByteLength, bytes.length);
      expect(progress.last, 1);
      expect(storeFactory.latest!.isCommitted, isTrue);
      expect(storeFactory.latest!.disposed, isTrue);
    } finally {
      await directory.delete(recursive: true);
    }
  });

  test('登録デコーダーが無い受理済みRAWを成功扱いにしない', () async {
    final Directory directory =
        await Directory.systemTemp.createTemp('mobile-stack-phase2-nef-');
    final File file = File(
      '${directory.path}${Platform.pathSeparator}input.nef',
    );
    final Uint8List bytes = Uint8List(32)
      ..[0] = 0x49
      ..[1] = 0x49
      ..[2] = 0x2A
      ..[3] = 0x00;
    await file.writeAsBytes(bytes, flush: true);
    final ProcessingJob job = ProcessingJob(
      id: 'nef-job',
      mode: ProcessingMode.milkyWay,
      sourcePath: file.path,
    );
    try {
      await expectLater(
        runPhase2ValidatedJob(
          job,
          (_) {},
          decoderRegistry: RawDecoderRegistry(<RawDecoder>[]),
        ),
        throwsA(isA<RawDecoderUnavailable>()),
      );
    } finally {
      await directory.delete(recursive: true);
    }
  });

  test(
    'onTileStoreReadyを渡すとコミット済みタイルストアが破棄されずに引き'
    '継がれる（星の軌跡・流星モードのような複数フレーム合成向け）',
    () async {
      final Directory directory = await Directory.systemTemp.createTemp(
        'mobile-stack-phase2-retain-',
      );
      final File file = File(
        '${directory.path}${Platform.pathSeparator}input.arw',
      );
      final Uint8List bytes = Uint8List(32)
        ..[0] = 0x49
        ..[1] = 0x49
        ..[2] = 0x2A
        ..[3] = 0x00;
      await file.writeAsBytes(bytes, flush: true);
      final _RecordingArwBackend backend = _RecordingArwBackend();
      final RawDecoderRegistry registry = RawDecoderRegistry(
        <RawDecoder>[
          NativeRawDecoder(
            backend: backend,
            supportedFormats: const <RawFormat>{RawFormat.arw},
            decoderId: 'test-arw-lossless',
          ),
        ],
      );
      final ProcessingJob job = ProcessingJob(
        id: 'retain-job',
        mode: ProcessingMode.starTrail,
        sourcePath: file.path,
      );
      final RecordingRgbTileStoreFactory storeFactory =
          RecordingRgbTileStoreFactory();
      RecordingRgbTileStore? handedOffStore;
      try {
        await runPhase2ValidatedJob(
          job,
          (_) {},
          decoderRegistry: registry,
          demosaicRegistry: DemosaicRegistry(
            <DemosaicEngine>[_TestProductionDemosaic()],
          ),
          rgbTileStoreFactory: storeFactory.call,
          onTileStoreReady: (LinearRgbTileStore tileStore) {
            handedOffStore = tileStore as RecordingRgbTileStore;
          },
        );

        // コールバック実行時点ではまだコミット済みかつ未破棄でなければ
        // ならない（破棄後に渡されても呼び出し元は使えない）。
        expect(handedOffStore, isNotNull);
        expect(identical(handedOffStore, storeFactory.latest), isTrue);
        expect(handedOffStore!.isCommitted, isTrue);

        // 関数全体が完了した後も、コールバックへ渡した後は
        // runPhase2ValidatedJob 自身の finally が破棄してはならない
        // （所有権はコールバック側へ移っているため）。
        expect(handedOffStore!.disposed, isFalse);
      } finally {
        await handedOffStore?.dispose();
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'onTileStoreReadyが例外を投げた場合は所有権が移らず、既存どおり '
    'finally でタイルストアが破棄される',
    () async {
      final Directory directory = await Directory.systemTemp.createTemp(
        'mobile-stack-phase2-retain-error-',
      );
      final File file = File(
        '${directory.path}${Platform.pathSeparator}input.arw',
      );
      final Uint8List bytes = Uint8List(32)
        ..[0] = 0x49
        ..[1] = 0x49
        ..[2] = 0x2A
        ..[3] = 0x00;
      await file.writeAsBytes(bytes, flush: true);
      final _RecordingArwBackend backend = _RecordingArwBackend();
      final RawDecoderRegistry registry = RawDecoderRegistry(
        <RawDecoder>[
          NativeRawDecoder(
            backend: backend,
            supportedFormats: const <RawFormat>{RawFormat.arw},
            decoderId: 'test-arw-lossless',
          ),
        ],
      );
      final ProcessingJob job = ProcessingJob(
        id: 'retain-error-job',
        mode: ProcessingMode.starTrail,
        sourcePath: file.path,
      );
      final RecordingRgbTileStoreFactory storeFactory =
          RecordingRgbTileStoreFactory();
      try {
        await expectLater(
          runPhase2ValidatedJob(
            job,
            (_) {},
            decoderRegistry: registry,
            demosaicRegistry: DemosaicRegistry(
              <DemosaicEngine>[_TestProductionDemosaic()],
            ),
            rgbTileStoreFactory: storeFactory.call,
            onTileStoreReady: (LinearRgbTileStore tileStore) {
              throw StateError('コールバック内で意図的に失敗させる');
            },
          ),
          throwsA(isA<StateError>()),
        );
        expect(storeFactory.latest!.disposed, isTrue);
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'masterDarkを指定すると、デモザイクまで含む本番パイプラインが'
    'ダーク減算・ホットピクセル検出込みで最後まで正常完走する'
    '(Work109: 星の軌跡・天の川・流星群の3モードが使う本番パイプライン'
    'への配線検証。これまでダーク/フラット較正はCFA drizzle実験的'
    'パイプラインからしか到達できなかった)',
    () async {
      final Directory directory = await Directory.systemTemp.createTemp(
        'mobile-stack-phase2-master-dark-',
      );
      final File file = File(
        '${directory.path}${Platform.pathSeparator}input.arw',
      );
      final Uint8List bytes = Uint8List(32)
        ..[0] = 0x49
        ..[1] = 0x49
        ..[2] = 0x2A
        ..[3] = 0x00;
      await file.writeAsBytes(bytes, flush: true);
      final _RecordingArwBackend backend = _RecordingArwBackend();
      final RawDecoderRegistry registry = RawDecoderRegistry(
        <RawDecoder>[
          NativeRawDecoder(
            backend: backend,
            supportedFormats: const <RawFormat>{RawFormat.arw},
            decoderId: 'test-arw-lossless',
          ),
        ],
      );
      final ProcessingJob job = ProcessingJob(
        id: 'arw-master-dark-job',
        mode: ProcessingMode.milkyWay,
        sourcePath: file.path,
      );
      final RecordingRgbTileStoreFactory storeFactory =
          RecordingRgbTileStoreFactory();
      // _RecordingArwBackendは2x2フレームを返すため、masterDarkも
      // 同じ寸法・CFAパターンで用意する。
      final LinearRawMosaic masterDark = LinearRawMosaic(
        width: 2,
        height: 2,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(<double>[0, 0, 0, 0]),
      );
      try {
        final List<double> progress = <double>[];
        LinearRgbTileStore? readyStore;
        await runPhase2ValidatedJob(
          job,
          progress.add,
          decoderRegistry: registry,
          demosaicRegistry: DemosaicRegistry(
            <DemosaicEngine>[_TestProductionDemosaic()],
          ),
          rgbTileStoreFactory: storeFactory.call,
          masterDark: masterDark,
          onTileStoreReady: (LinearRgbTileStore tileStore) async {
            readyStore = tileStore;
          },
        );

        expect(progress.last, 1);
        expect(readyStore, isNotNull);
        expect(storeFactory.latest!.isCommitted, isTrue);
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test(
      'render metadata callback receives same-frame merged metadata only after success',
      () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-phase2-render-metadata-',
    );
    final File file =
        File('${directory.path}${Platform.pathSeparator}input.arw');
    final Uint8List bytes = Uint8List(32)
      ..[0] = 0x49
      ..[1] = 0x49
      ..[2] = 0x2A
      ..[3] = 0x00;
    await file.writeAsBytes(bytes, flush: true);
    final _RecordingArwBackend backend = _RecordingArwBackend();
    final RawDecoderRegistry registry = RawDecoderRegistry(<RawDecoder>[
      NativeRawDecoder(
        backend: backend,
        supportedFormats: const <RawFormat>{RawFormat.arw},
        decoderId: 'test-arw-lossless',
      ),
    ]);
    final RawFrameMetadata probed = RawFrameMetadata(
      format: RawFormat.arw,
      activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
      orientation: 1,
      blackLevels: const <double>[999, 999, 999, 999],
      whiteLevel: 9999,
      cameraWhiteBalance: const <double>[9, 9, 9, 9],
      d65XyzToCamera: const <double>[1, 0, 0, 0, 1, 0, 0, 0, 1],
      baselineExposure: 0.5,
      baselineExposureOffset: -0.25,
      profileToneCurve: const <double>[0, 0, 1, 1],
    );
    RawFrameMetadata? callbackMetadata;
    CfaPattern? callbackPattern;
    final RecordingRgbTileStoreFactory storeFactory =
        RecordingRgbTileStoreFactory();
    try {
      await runPhase2ValidatedJob(
        ProcessingJob(
          id: 'render-metadata-job',
          mode: ProcessingMode.milkyWay,
          sourcePath: file.path,
        ),
        (_) {},
        metadataProbe: _StaticMetadataProbe(probed),
        decoderRegistry: registry,
        demosaicRegistry:
            DemosaicRegistry(<DemosaicEngine>[_TestProductionDemosaic()]),
        rgbTileStoreFactory: storeFactory.call,
        onRenderMetadataReady: (RawFrameMetadata metadata, CfaPattern pattern) {
          callbackMetadata = metadata;
          callbackPattern = pattern;
        },
      );

      expect(callbackMetadata, isNotNull);
      expect(callbackPattern, CfaPattern.rggb);
      expect(callbackMetadata!.blackLevels,
          orderedEquals(<double>[512, 512, 512, 512]));
      expect(callbackMetadata!.whiteLevel, 16383);
      expect(callbackMetadata!.cameraWhiteBalance,
          orderedEquals(<double>[2, 1, 1, 1.5]));
      expect(callbackMetadata!.d65XyzToCamera, probed.d65XyzToCamera);
      expect(callbackMetadata!.baselineExposure, 0.5);
      expect(callbackMetadata!.baselineExposureOffset, -0.25);
      expect(callbackMetadata!.profileToneCurve, probed.profileToneCurve);
    } finally {
      await directory.delete(recursive: true);
    }
  });

  test('render metadata callback is not emitted for a cancelled job', () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-phase2-render-cancel-',
    );
    final File file =
        File('${directory.path}${Platform.pathSeparator}input.arw');
    final Uint8List bytes = Uint8List(32)
      ..[0] = 0x49
      ..[1] = 0x49
      ..[2] = 0x2A
      ..[3] = 0x00;
    await file.writeAsBytes(bytes, flush: true);
    final _RecordingArwBackend backend = _RecordingArwBackend();
    final RawDecoderRegistry registry = RawDecoderRegistry(<RawDecoder>[
      NativeRawDecoder(
        backend: backend,
        supportedFormats: const <RawFormat>{RawFormat.arw},
        decoderId: 'test-arw-lossless',
      ),
    ]);
    final ProcessingJob job = ProcessingJob(
      id: 'render-cancel-job',
      mode: ProcessingMode.milkyWay,
      sourcePath: file.path,
    );
    bool callbackCalled = false;
    final RecordingRgbTileStoreFactory storeFactory =
        RecordingRgbTileStoreFactory();
    try {
      await runPhase2ValidatedJob(
        job,
        (_) {},
        decoderRegistry: registry,
        demosaicRegistry: DemosaicRegistry(<DemosaicEngine>[
          _CancellingDemosaic(job.requestCancellation),
        ]),
        rgbTileStoreFactory: storeFactory.call,
        onRenderMetadataReady: (_, __) => callbackCalled = true,
      );
      expect(job.cancellationRequested, isTrue);
      expect(callbackCalled, isFalse);
    } finally {
      await directory.delete(recursive: true);
    }
  });
}
