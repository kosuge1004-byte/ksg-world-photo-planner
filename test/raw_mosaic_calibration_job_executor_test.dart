import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/color/raw_camera_color_profile.dart';
import 'package:mobile_stack/core/engine/processing_job.dart';
import 'package:mobile_stack/core/engine/raw_mosaic_calibration_job_executor.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/core/raw/native_raw_decoder.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_decoder_registry.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_metadata_probe.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';
import 'package:mobile_stack/core/raw/raw_probe_result.dart';

/// [runRawMosaicCalibrationJob]の直接テスト。本体のロジック(較正の
/// 各段そのものの数値的な正しさ)は`RawMosaicCalibrator`自身の既存
/// テストで既に検証済みのため、ここでの主眼は配線: デモザイクへ進まず
/// 較正済みモザイクが[onMosaicReady]へ届くこと、キャンセルや不正入力
/// の扱いが[runPhase2ValidatedJob]と同じ流儀で処理されること。

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
      activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
      orientation: 1,
      blackLevels: const <double>[512, 512, 512, 512],
      whiteLevel: 16383,
      cameraWhiteBalance: const <double>[2, 1, 1, 1.5],
      samples: Float32List.fromList(<double>[512, 513, 514, 515]),
    );
  }
}

/// [_RecordingArwBackend]は固定の2x2フレームしか返せない(不良画素
/// 補正の近傍補間を検証するには小さすぎる)。このバックエンドは
/// 呼び出し元が用意した任意のフレームをそのまま返す。
class _FixedFrameArwBackend implements RawNativeDecodeBackend {
  _FixedFrameArwBackend(this.frame);

  final RawNativeDecodedFrame frame;

  @override
  Future<RawNativeDecodedFrame> decode(
    RawNativeDecodeCommand command,
  ) async {
    return frame;
  }
}

class _FixedArwMetadataProbe implements RawMetadataProbe {
  const _FixedArwMetadataProbe(
    this.matrix, {
    this.cameraWhiteBalance,
    this.baselineExposure,
    this.baselineExposureOffset,
  });

  final List<double> matrix;
  final List<double>? cameraWhiteBalance;
  final double? baselineExposure;
  final double? baselineExposureOffset;

  @override
  bool supports(RawFormat format) => format == RawFormat.arw;

  @override
  Future<RawMetadataProbeResult> probe(RawProbeResult source) async {
    return RawMetadataProbeResult(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      metadata: RawFrameMetadata(
        format: RawFormat.arw,
        activeArea: const RawActiveArea(
          left: 0,
          top: 0,
          width: 2,
          height: 2,
        ),
        orientation: 1,
        blackLevels: const <double>[512, 512, 512, 512],
        whiteLevel: 16383,
        cameraWhiteBalance: cameraWhiteBalance,
        d65XyzToCamera: matrix,
        baselineExposure: baselineExposure,
        baselineExposureOffset: baselineExposureOffset,
      ),
      probeId: 'fixed-arw-metadata',
    );
  }
}

Future<File> _writeArwFile(Directory directory) async {
  final File file = File(
    '${directory.path}${Platform.pathSeparator}input.arw',
  );
  final Uint8List bytes = Uint8List(32)
    ..[0] = 0x49
    ..[1] = 0x49
    ..[2] = 0x2A
    ..[3] = 0x00;
  await file.writeAsBytes(bytes, flush: true);
  return file;
}

void main() {
  test('singular probed color matrix fails before publishing the mosaic',
      () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-singular-color-profile-',
    );
    try {
      final File file = await _writeArwFile(directory);
      final RawDecoderRegistry registry = RawDecoderRegistry(
        <RawDecoder>[
          NativeRawDecoder(
            backend: _RecordingArwBackend(),
            supportedFormats: const <RawFormat>{RawFormat.arw},
            decoderId: 'test-arw-lossless',
          ),
        ],
      );
      bool mosaicPublished = false;

      await expectLater(
        runRawMosaicCalibrationJob(
          ProcessingJob(
            id: 'singular-color-profile-job',
            mode: ProcessingMode.milkyWay,
            sourcePath: file.path,
          ),
          (_) {},
          metadataProbe: _FixedArwMetadataProbe(List<double>.filled(9, 0)),
          decoderRegistry: registry,
          onColorProfileReady: (_) {},
          onMosaicReady: (_) {
            mosaicPublished = true;
          },
        ),
        throwsA(isA<InvalidRawCameraColorProfile>()),
      );
      expect(mosaicPublished, isFalse);
    } finally {
      await directory.delete(recursive: true);
    }
  });

  test('metadata probe matrix and decoded phase WB form one color profile',
      () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-raw-color-profile-',
    );
    try {
      final File file = await _writeArwFile(directory);
      const List<double> matrix = <double>[
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
      ];
      final RawDecoderRegistry registry = RawDecoderRegistry(
        <RawDecoder>[
          NativeRawDecoder(
            backend: _RecordingArwBackend(),
            supportedFormats: const <RawFormat>{RawFormat.arw},
            decoderId: 'test-arw-lossless',
          ),
        ],
      );
      RawCameraColorProfile? receivedProfile;

      await runRawMosaicCalibrationJob(
        ProcessingJob(
          id: 'raw-color-profile-job',
          mode: ProcessingMode.milkyWay,
          sourcePath: file.path,
        ),
        (_) {},
        metadataProbe: const _FixedArwMetadataProbe(matrix),
        decoderRegistry: registry,
        onColorProfileReady: (RawCameraColorProfile? profile) {
          receivedProfile = profile;
        },
        onMosaicReady: (_) {},
      );

      expect(receivedProfile, isNotNull);
      expect(receivedProfile!.d65XyzToCamera, orderedEquals(matrix));
      expect(
        receivedProfile!.phaseWhiteBalance,
        orderedEquals(<double>[2, 1, 1, 1.5]),
      );
    } finally {
      await directory.delete(recursive: true);
    }
  });

  test(
    'CFA drizzle executor falls back to probed WB and publishes merged '
    'render metadata without mixing frames',
    () async {
      final Directory directory = await Directory.systemTemp.createTemp(
        'mobile-stack-raw-render-metadata-',
      );
      try {
        final File file = await _writeArwFile(directory);
        const List<double> matrix = <double>[
          1,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          1,
        ];
        const List<double> probeWhiteBalance = <double>[2.2, 1, 1, 1.6];
        final RawNativeDecodedFrame decodedWithoutOptionalRenderMetadata =
            RawNativeDecodedFrame(
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
          samples: Float32List.fromList(<double>[512, 513, 514, 515]),
        );
        final RawDecoderRegistry registry = RawDecoderRegistry(
          <RawDecoder>[
            NativeRawDecoder(
              backend: _FixedFrameArwBackend(
                decodedWithoutOptionalRenderMetadata,
              ),
              supportedFormats: const <RawFormat>{RawFormat.arw},
              decoderId: 'test-arw-probe-render-fallback',
            ),
          ],
        );
        RawCameraColorProfile? receivedColorProfile;
        RawFrameMetadata? receivedRenderMetadata;
        CfaPattern? receivedPattern;

        await runRawMosaicCalibrationJob(
          ProcessingJob(
            id: 'raw-render-metadata-job',
            mode: ProcessingMode.milkyWay,
            sourcePath: file.path,
          ),
          (_) {},
          metadataProbe: const _FixedArwMetadataProbe(
            matrix,
            cameraWhiteBalance: probeWhiteBalance,
            baselineExposure: 0.5,
            baselineExposureOffset: -0.25,
          ),
          decoderRegistry: registry,
          onColorProfileReady: (RawCameraColorProfile? profile) {
            receivedColorProfile = profile;
          },
          onRenderMetadataReady: (
            RawFrameMetadata metadata,
            CfaPattern cfaPattern,
          ) {
            receivedRenderMetadata = metadata;
            receivedPattern = cfaPattern;
          },
          onMosaicReady: (_) {},
        );

        expect(receivedColorProfile, isNotNull);
        expect(
          receivedColorProfile!.phaseWhiteBalance,
          orderedEquals(probeWhiteBalance),
        );
        expect(receivedRenderMetadata, isNotNull);
        expect(
          receivedRenderMetadata!.cameraWhiteBalance,
          orderedEquals(probeWhiteBalance),
        );
        expect(receivedRenderMetadata!.d65XyzToCamera, orderedEquals(matrix));
        expect(receivedRenderMetadata!.baselineExposure, 0.5);
        expect(receivedRenderMetadata!.baselineExposureOffset, -0.25);
        expect(receivedRenderMetadata!.totalBaselineExposure, 0.25);
        expect(receivedPattern, CfaPattern.rggb);
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    '較正済み(デモザイク前)のRAWモザイクがonMosaicReadyへ届き、'
    '黒レベル控除が実際に適用されている',
    () async {
      final Directory directory = await Directory.systemTemp.createTemp(
        'mobile-stack-raw-mosaic-calibration-',
      );
      try {
        final File file = await _writeArwFile(directory);
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
          id: 'raw-mosaic-job',
          mode: ProcessingMode.milkyWay,
          sourcePath: file.path,
        );

        LinearRawMosaic? received;
        final List<double> progress = <double>[];
        await runRawMosaicCalibrationJob(
          job,
          progress.add,
          decoderRegistry: registry,
          onMosaicReady: (LinearRawMosaic mosaic) {
            received = mosaic;
          },
        );

        expect(backend.command, isNotNull);
        expect(progress.last, 1);
        expect(received, isNotNull);
        expect(received!.width, 2);
        expect(received!.height, 2);
        expect(received!.cfaPattern, CfaPattern.rggb);
        // 黒レベル512を差し引いた後なので、元の生値512〜515よりも
        // 大幅に小さい値になっているはず(較正が実際に適用された
        // ことの確認 -- 具体的な数値そのものはRawMosaicCalibrator
        // 自身のテストで既に検証済み)。
        for (final double value in received!.samples) {
          expect(value.abs(), lessThan(10));
        }
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test('登録デコーダーが無い受理済みRAWを成功扱いにしない', () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-raw-mosaic-calibration-nodecoder-',
    );
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
        runRawMosaicCalibrationJob(
          job,
          (_) {},
          decoderRegistry: RawDecoderRegistry(<RawDecoder>[]),
          onMosaicReady: (LinearRawMosaic mosaic) {},
        ),
        throwsA(isA<RawDecoderUnavailable>()),
      );
    } finally {
      await directory.delete(recursive: true);
    }
  });

  test(
    'デコード完了前にキャンセルされた場合はonMosaicReadyを呼ばない',
    () async {
      final Directory directory = await Directory.systemTemp.createTemp(
        'mobile-stack-raw-mosaic-calibration-cancel-',
      );
      try {
        final File file = await _writeArwFile(directory);
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
          id: 'cancelled-job',
          mode: ProcessingMode.milkyWay,
          sourcePath: file.path,
        );
        job.requestCancellation();

        bool called = false;
        await runRawMosaicCalibrationJob(
          job,
          (_) {},
          decoderRegistry: registry,
          onMosaicReady: (LinearRawMosaic mosaic) {
            called = true;
          },
        );
        expect(called, isFalse);
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'masterDarkを指定すると黒レベル補正の直後にダークフレーム減算が'
    '適用され、指定しない場合と結果が異なる(Work97: 配線の検証)',
    () async {
      final Directory directory = await Directory.systemTemp.createTemp(
        'mobile-stack-raw-mosaic-calibration-dark-',
      );
      try {
        final File file = await _writeArwFile(directory);
        RawDecoderRegistry buildRegistry() => RawDecoderRegistry(
              <RawDecoder>[
                NativeRawDecoder(
                  backend: _RecordingArwBackend(),
                  supportedFormats: const <RawFormat>{RawFormat.arw},
                  decoderId: 'test-arw-lossless',
                ),
              ],
            );

        LinearRawMosaic? withoutDark;
        await runRawMosaicCalibrationJob(
          ProcessingJob(
            id: 'no-dark-job',
            mode: ProcessingMode.milkyWay,
            sourcePath: file.path,
          ),
          (_) {},
          decoderRegistry: buildRegistry(),
          onMosaicReady: (LinearRawMosaic mosaic) => withoutDark = mosaic,
        );

        // フェイクバックエンドの生値は[512,513,514,515]、黒レベルは
        // 全て512なので、黒レベル補正直後の値は[0,1,2,3]になるはず。
        // ここへ意図的に大きめのダーク値を与え、減算の有無で最終結果が
        // 明確に変わることを確認する。
        final LinearRawMosaic masterDark = LinearRawMosaic(
          width: 2,
          height: 2,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List.fromList(<double>[0, 0.5, 1, 1.5]),
        );
        LinearRawMosaic? withDark;
        await runRawMosaicCalibrationJob(
          ProcessingJob(
            id: 'with-dark-job',
            mode: ProcessingMode.milkyWay,
            sourcePath: file.path,
          ),
          (_) {},
          decoderRegistry: buildRegistry(),
          masterDark: masterDark,
          onMosaicReady: (LinearRawMosaic mosaic) => withDark = mosaic,
        );

        expect(withoutDark, isNotNull);
        expect(withDark, isNotNull);
        // masterDarkを指定した場合としない場合で、較正済みモザイクの
        // 値が実際に異なることを確認する(配線が実際に効いていること
        // の直接証拠)。
        expect(
          withDark!.samples,
          isNot(orderedEquals(withoutDark!.samples)),
        );
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'masterFlatを指定するとフラットフィールド補正が適用され、'
    '指定しない場合と結果が異なる(Work98: 配線の検証)',
    () async {
      final Directory directory = await Directory.systemTemp.createTemp(
        'mobile-stack-raw-mosaic-calibration-flat-',
      );
      try {
        final File file = await _writeArwFile(directory);
        RawDecoderRegistry buildRegistry() => RawDecoderRegistry(
              <RawDecoder>[
                NativeRawDecoder(
                  backend: _RecordingArwBackend(),
                  supportedFormats: const <RawFormat>{RawFormat.arw},
                  decoderId: 'test-arw-lossless',
                ),
              ],
            );

        LinearRawMosaic? withoutFlat;
        await runRawMosaicCalibrationJob(
          ProcessingJob(
            id: 'no-flat-job',
            mode: ProcessingMode.milkyWay,
            sourcePath: file.path,
          ),
          (_) {},
          decoderRegistry: buildRegistry(),
          onMosaicReady: (LinearRawMosaic mosaic) => withoutFlat = mosaic,
        );

        // 一様でないマスターフラット(周辺減光を模した勾配)を与える。
        final LinearRawMosaic masterFlat = LinearRawMosaic(
          width: 2,
          height: 2,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List.fromList(<double>[0.8, 1, 1, 1.2]),
        );
        LinearRawMosaic? withFlat;
        await runRawMosaicCalibrationJob(
          ProcessingJob(
            id: 'with-flat-job',
            mode: ProcessingMode.milkyWay,
            sourcePath: file.path,
          ),
          (_) {},
          decoderRegistry: buildRegistry(),
          masterFlat: masterFlat,
          onMosaicReady: (LinearRawMosaic mosaic) => withFlat = mosaic,
        );

        expect(withoutFlat, isNotNull);
        expect(withFlat, isNotNull);
        expect(
          withFlat!.samples,
          isNot(orderedEquals(withoutFlat!.samples)),
        );
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'masterDarkとmasterFlatを同時に指定すると両方が適用される'
    '(Work98: 組み合わせの配線検証)',
    () async {
      final Directory directory = await Directory.systemTemp.createTemp(
        'mobile-stack-raw-mosaic-calibration-both-',
      );
      try {
        final File file = await _writeArwFile(directory);
        RawDecoderRegistry buildRegistry() => RawDecoderRegistry(
              <RawDecoder>[
                NativeRawDecoder(
                  backend: _RecordingArwBackend(),
                  supportedFormats: const <RawFormat>{RawFormat.arw},
                  decoderId: 'test-arw-lossless',
                ),
              ],
            );

        final LinearRawMosaic masterDark = LinearRawMosaic(
          width: 2,
          height: 2,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List.fromList(<double>[0, 0.5, 1, 1.5]),
        );
        final LinearRawMosaic masterFlat = LinearRawMosaic(
          width: 2,
          height: 2,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List.fromList(<double>[0.8, 1, 1, 1.2]),
        );

        LinearRawMosaic? bothApplied;
        LinearRawMosaic? darkOnly;
        await runRawMosaicCalibrationJob(
          ProcessingJob(
            id: 'both-job',
            mode: ProcessingMode.milkyWay,
            sourcePath: file.path,
          ),
          (_) {},
          decoderRegistry: buildRegistry(),
          masterDark: masterDark,
          masterFlat: masterFlat,
          onMosaicReady: (LinearRawMosaic mosaic) => bothApplied = mosaic,
        );
        await runRawMosaicCalibrationJob(
          ProcessingJob(
            id: 'dark-only-job',
            mode: ProcessingMode.milkyWay,
            sourcePath: file.path,
          ),
          (_) {},
          decoderRegistry: buildRegistry(),
          masterDark: masterDark,
          onMosaicReady: (LinearRawMosaic mosaic) => darkOnly = mosaic,
        );

        expect(bothApplied, isNotNull);
        expect(darkOnly, isNotNull);
        // 両方適用した結果は、ダークのみ適用した結果とも異なるはず
        // (フラット補正の分だけ追加で効いていることの確認)。
        expect(
          bothApplied!.samples,
          isNot(orderedEquals(darkOnly!.samples)),
        );
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'masterDarkのホットピクセルが自動検出され、実際に較正済み'
    'モザイクで補正される(Work108: 不良画素補正パイプラインの配線検証。'
    '不良画素補正ステージ自体は以前から存在していたが、'
    'context.rawDefectMapがどこからも実際に設定されたことが無く常に'
    'スキップされ続けていた、というプロジェクト内の長年のギャップを'
    '埋める)',
    () async {
      // 6x6モザイク: RGGBの各位相について複数画素を持つ十分な大きさに
      // し、不良画素補正の近傍補間が実際に機能する条件を作る。
      const int width = 6;
      const int height = 6;
      const int hotX = 2;
      const int hotY = 2; // rggbでx,yとも偶数 -> RED位相。

      num lightValue(int x, int y) {
        if (x == hotX && y == hotY) return 5000; // ホットピクセル
        return 100 + x + y; // 通常の背景変化
      }

      final Float32List lightSamples = Float32List(width * height);
      final Float32List darkSamples = Float32List(width * height);
      for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
          final int index = y * width + x;
          lightSamples[index] = lightValue(x, y).toDouble();
          // masterDarkは既に黒レベル控除済みという契約
          // (prepareMasterDark, Work104の出力形式)に合わせ、黒レベル
          // は加算しない。同じ画素で固定パターンノイズが強く出ている
          // ことだけを模す。
          darkSamples[index] = (x == hotX && y == hotY) ? 4500 : 30;
        }
      }

      final Directory directory = await Directory.systemTemp.createTemp(
        'mobile-stack-hot-pixel-wiring-',
      );
      try {
        final File file = await _writeArwFile(directory);
        final RawDecoderRegistry registry = RawDecoderRegistry(
          <RawDecoder>[
            NativeRawDecoder(
              backend: _FixedFrameArwBackend(
                RawNativeDecodedFrame(
                  format: RawFormat.arw,
                  width: width,
                  height: height,
                  cfaPattern: CfaPattern.rggb,
                  activeArea: const RawActiveArea(
                    left: 0,
                    top: 0,
                    width: width,
                    height: height,
                  ),
                  orientation: 1,
                  blackLevels: const <double>[512, 512, 512, 512],
                  whiteLevel: 16383,
                  cameraWhiteBalance: const <double>[1, 1, 1, 1],
                  samples: Float32List.fromList(<double>[
                    for (int i = 0; i < lightSamples.length; i++)
                      lightSamples[i] + 512, // 黒レベルを加えた生の値
                  ]),
                ),
              ),
              supportedFormats: const <RawFormat>{RawFormat.arw},
              decoderId: 'test-arw',
            ),
          ],
        );
        final LinearRawMosaic masterDark = LinearRawMosaic(
          width: width,
          height: height,
          cfaPattern: CfaPattern.rggb,
          samples: darkSamples,
        );

        LinearRawMosaic? calibrated;
        await runRawMosaicCalibrationJob(
          ProcessingJob(
            id: 'hot-pixel-job',
            mode: ProcessingMode.milkyWay,
            sourcePath: file.path,
          ),
          (_) {},
          decoderRegistry: registry,
          masterDark: masterDark,
          enableHotPixelDetection: true,
          onMosaicReady: (LinearRawMosaic mosaic) => calibrated = mosaic,
        );

        expect(calibrated, isNotNull);
        final double hotPixelValue = calibrated!.samples[hotY * width + hotX];
        // 同じ位相(RED, x,yとも偶数)の近傍画素を、同じ較正済み
        // モザイクから読み、その平均と比較する。ホワイトレベル
        // 正規化がどんなスケール係数を適用していても、この比較は
        // スケールに依存しない(両方とも同じ係数で一様にスケール
        // されるため)。
        final List<double> sameNeighborPhaseValues = <double>[
          calibrated!.samples[0 * width + 0], // (0,0) 同じ偶数,偶数位相
          calibrated!.samples[0 * width + 4], // (4,0)
          calibrated!.samples[4 * width + 0], // (0,4)
        ];
        final double neighborAverage =
            sameNeighborPhaseValues.reduce((a, b) => a + b) /
                sameNeighborPhaseValues.length;
        // 補正されていれば、ホットピクセルの値は近傍平均の高々数倍
        // 程度のはず(補正前は近傍の数十倍にもなっていたはずと対比)。
        expect(
          hotPixelValue,
          lessThan(neighborAverage * 3),
          reason: 'expected the hot pixel to be corrected via interpolation '
              'from its neighbors: hotPixelValue=$hotPixelValue, '
              'neighborAverage=$neighborAverage',
        );
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );
}
