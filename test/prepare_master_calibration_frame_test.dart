import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/engine/prepare_master_calibration_frame.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_raw_mosaic_store.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/pipeline/dark_frame_subtraction.dart';
import 'package:mobile_stack/core/raw/native_raw_decoder.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_decoder_registry.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_metadata_probe.dart';
import 'package:mobile_stack/core/raw/raw_probe_result.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';

/// Tests [prepareMasterDark]/[prepareMasterFlat] directly. The
/// combining math itself (median, normalization) is already verified by
/// `dark_frame_subtraction_test.dart` (Work96) and
/// `flat_field_calibration_test.dart` (Work98); this file's job is the
/// new decode-and-stop-at-black-level orchestration specifically.

/// Returns a different, pre-set decoded frame each call, in order —
/// unlike `raw_mosaic_calibration_job_executor_test.dart`'s own
/// `_RecordingArwBackend` (which always returns the same fixed frame),
/// this lets a test simulate several *distinct* calibration frames
/// (needed to exercise `computeMasterDark`'s own median-combine logic
/// meaningfully).
class _QueuedArwBackend implements RawNativeDecodeBackend {
  _QueuedArwBackend(this._queue);

  final List<RawNativeDecodedFrame> _queue;
  int _nextIndex = 0;

  @override
  Future<RawNativeDecodedFrame> decode(RawNativeDecodeCommand command) async {
    final RawNativeDecodedFrame frame = _queue[_nextIndex];
    _nextIndex++;
    return frame;
  }
}

RawNativeDecodedFrame _frame(List<double> samples) {
  return RawNativeDecodedFrame(
    format: RawFormat.arw,
    width: 2,
    height: 2,
    cfaPattern: CfaPattern.rggb,
    activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
    orientation: 1,
    blackLevels: const <double>[512, 512, 512, 512],
    whiteLevel: 16383,
    cameraWhiteBalance: const <double>[1, 1, 1, 1],
    samples: Float32List.fromList(samples),
  );
}

class _FixedMetadataProbe implements RawMetadataProbe {
  _FixedMetadataProbe(this.metadata);

  final RawFrameMetadata metadata;

  @override
  bool supports(RawFormat format) => format == metadata.format;

  @override
  Future<RawMetadataProbeResult> probe(RawProbeResult source) async {
    return RawMetadataProbeResult(
      width: metadata.activeArea.width,
      height: metadata.activeArea.height,
      cfaPattern: CfaPattern.rggb,
      metadata: metadata,
      probeId: 'fixed-metadata',
    );
  }
}

RawNativeDecodedFrame _frameWithBlackLevel(
  List<double> samples,
  double blackLevel,
) {
  return RawNativeDecodedFrame(
    format: RawFormat.arw,
    width: 2,
    height: 2,
    cfaPattern: CfaPattern.rggb,
    activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
    orientation: 1,
    blackLevels: <double>[blackLevel, blackLevel, blackLevel, blackLevel],
    whiteLevel: 255,
    cameraWhiteBalance: const <double>[1, 1, 1, 1],
    samples: Float32List.fromList(samples),
  );
}

Future<Directory> _writeArwFiles(int count) async {
  final Directory directory = await Directory.systemTemp.createTemp(
    'mobile-stack-prepare-master-frame-',
  );
  for (int i = 0; i < count; i++) {
    final File file = File(
      '${directory.path}${Platform.pathSeparator}frame$i.arw',
    );
    final Uint8List bytes = Uint8List(32)
      ..[0] = 0x49
      ..[1] = 0x49
      ..[2] = 0x2A
      ..[3] = 0x00;
    await file.writeAsBytes(bytes, flush: true);
  }
  return directory;
}

void main() {
  test(
    'prepareMasterDark: 各フレームに黒レベル補正だけを適用してから'
    '中央値合成する(較正の他段は適用しない)',
    () async {
      // 黒レベルは全て512。3フレーム、ある1画素だけ値を変えて中央値が
      // 分かるようにする: [512,513,514]->黒レベル控除後[0,1,2]->中央値1。
      final Directory directory = await _writeArwFiles(3);
      final RawDecoderRegistry registry = RawDecoderRegistry(<RawDecoder>[
        NativeRawDecoder(
          backend: _QueuedArwBackend(<RawNativeDecodedFrame>[
            _frame(<double>[512, 512, 512, 512]),
            _frame(<double>[513, 512, 512, 512]),
            _frame(<double>[514, 512, 512, 512]),
          ]),
          supportedFormats: const <RawFormat>{RawFormat.arw},
          decoderId: 'test-arw',
        ),
      ]);
      try {
        final LinearRawMosaic master = await prepareMasterDark(
          sourcePaths: <String>[
            '${directory.path}${Platform.pathSeparator}frame0.arw',
            '${directory.path}${Platform.pathSeparator}frame1.arw',
            '${directory.path}${Platform.pathSeparator}frame2.arw',
          ],
          decoderRegistry: registry,
        );
        expect(master.width, 2);
        expect(master.height, 2);
        expect(master.cfaPattern, CfaPattern.rggb);
        // 画素0の黒レベル控除後の値は[0,1,2] -> 中央値1。
        expect(master.samples[0], 1);
        // 他の画素は常に0(512-512)のまま。
        expect(master.samples[1], 0);
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'prepareMasterFlat: darkToSubtractを指定すると各フレームから'
    'ダーク減算してから正規化合成する',
    () async {
      final Directory directory = await _writeArwFiles(1);
      final RawDecoderRegistry registry = RawDecoderRegistry(<RawDecoder>[
        NativeRawDecoder(
          backend: _QueuedArwBackend(<RawNativeDecodedFrame>[
            // 黒レベル控除後: [100,100,100,100]。
            _frame(<double>[612, 612, 612, 612]),
          ]),
          supportedFormats: const <RawFormat>{RawFormat.arw},
          decoderId: 'test-arw',
        ),
      ]);
      final LinearRawMosaic flatDark = LinearRawMosaic(
        width: 2,
        height: 2,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(<double>[10, 10, 10, 10]),
      );
      try {
        final LinearRawMosaic master = await prepareMasterFlat(
          sourcePaths: <String>[
            '${directory.path}${Platform.pathSeparator}frame0.arw',
          ],
          decoderRegistry: registry,
          darkToSubtract: flatDark,
        );
        // ダーク減算後は全画素90、正規化(平均で割る)後は全て1.0のはず。
        for (final double value in master.samples) {
          expect((value - 1).abs(), lessThan(1e-6));
        }
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'prepareMasterFlat: darkToSubtractを指定しない場合は黒レベル補正'
    'のみが適用される',
    () async {
      final Directory directory = await _writeArwFiles(1);
      final RawDecoderRegistry registry = RawDecoderRegistry(<RawDecoder>[
        NativeRawDecoder(
          backend: _QueuedArwBackend(<RawNativeDecodedFrame>[
            _frame(<double>[612, 612, 612, 612]),
          ]),
          supportedFormats: const <RawFormat>{RawFormat.arw},
          decoderId: 'test-arw',
        ),
      ]);
      try {
        final LinearRawMosaic master = await prepareMasterFlat(
          sourcePaths: <String>[
            '${directory.path}${Platform.pathSeparator}frame0.arw',
          ],
          decoderRegistry: registry,
        );
        // 黒レベル控除後は全画素100、正規化後は全て1.0のはず。
        for (final double value in master.samples) {
          expect((value - 1).abs(), lessThan(1e-6));
        }
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'prepareMasterDark: calibration RAW also applies probe LinearizationTable '
    'and BlackLevelDeltaH/V before combining',
    () async {
      final Directory directory = await _writeArwFiles(1);
      final RawDecoderRegistry registry = RawDecoderRegistry(<RawDecoder>[
        NativeRawDecoder(
          backend: _QueuedArwBackend(<RawNativeDecodedFrame>[
            _frameWithBlackLevel(<double>[10, 20, 30, 40], 5),
          ]),
          supportedFormats: const <RawFormat>{RawFormat.arw},
          decoderId: 'test-arw',
        ),
      ]);
      final List<double> table = <double>[
        for (int i = 0; i < 256; i++) i.toDouble(),
      ];
      table[10] = 100;
      final RawFrameMetadata metadata = RawFrameMetadata(
        format: RawFormat.arw,
        activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
        orientation: 1,
        blackLevels: const <double>[5, 5, 5, 5],
        whiteLevel: 255,
        linearizationTable: table,
        blackLevelDeltaH: const <double>[1, 2],
        blackLevelDeltaV: const <double>[3, 4],
      );
      try {
        final LinearRawMosaic master = await prepareMasterDark(
          sourcePaths: <String>[
            '${directory.path}${Platform.pathSeparator}frame0.arw',
          ],
          decoderRegistry: registry,
          metadataProbe: _FixedMetadataProbe(metadata),
        );
        expect(master.samples[0], 91); // 100 - 5 - 1 - 3
        expect(master.samples[1], 10); // 20 - 5 - 2 - 3
        expect(master.samples[2], 20); // 30 - 5 - 1 - 4
        expect(master.samples[3], 29); // 40 - 5 - 2 - 4
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'prepareMasterDark: 空のsourcePathsはInvalidDarkFrameInputを投げる',
    () async {
      final RawDecoderRegistry registry = RawDecoderRegistry(<RawDecoder>[]);
      await expectLater(
        prepareMasterDark(
          sourcePaths: const <String>[],
          decoderRegistry: registry,
        ),
        throwsA(isA<InvalidDarkFrameInput>()),
      );
    },
  );

  test('prepareMasterDark: 不正なRAWファイルはStateErrorを投げる', () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-prepare-master-frame-invalid-',
    );
    final File badFile = File(
      '${directory.path}${Platform.pathSeparator}bad.arw',
    );
    await badFile.writeAsBytes(Uint8List(4), flush: true); // シグネチャ不正
    final RawDecoderRegistry registry = RawDecoderRegistry(<RawDecoder>[
      NativeRawDecoder(
        backend: _QueuedArwBackend(<RawNativeDecodedFrame>[]),
        supportedFormats: const <RawFormat>{RawFormat.arw},
        decoderId: 'test-arw',
      ),
    ]);
    try {
      await expectLater(
        prepareMasterDark(
          sourcePaths: <String>[badFile.path],
          decoderRegistry: registry,
        ),
        throwsA(isA<StateError>()),
      );
    } finally {
      await directory.delete(recursive: true);
    }
  });

  test(
    'prepareMasterDarkStore: direct streamed output matches in-memory master',
    () async {
      final Directory directory = await _writeArwFiles(3);
      final List<List<double>> sourceSamples = <List<double>>[
        <double>[512, 612, 712, 812],
        <double>[514, 614, 714, 814],
        <double>[516, 616, 716, 816],
      ];
      RawDecoderRegistry registryForRun() => RawDecoderRegistry(<RawDecoder>[
            NativeRawDecoder(
              backend: _QueuedArwBackend(<RawNativeDecodedFrame>[
                for (final List<double> samples in sourceSamples)
                  _frame(samples),
              ]),
              supportedFormats: const <RawFormat>{RawFormat.arw},
              decoderId: 'test-arw',
            ),
          ]);
      FileBackedLinearRawMosaicStore? store;
      try {
        final LinearRawMosaic expected = await prepareMasterDark(
          sourcePaths: <String>[
            '${directory.path}${Platform.pathSeparator}frame0.arw',
            '${directory.path}${Platform.pathSeparator}frame1.arw',
            '${directory.path}${Platform.pathSeparator}frame2.arw',
          ],
          decoderRegistry: registryForRun(),
        );
        store = await prepareMasterDarkStore(
          sourcePaths: <String>[
            '${directory.path}${Platform.pathSeparator}frame0.arw',
            '${directory.path}${Platform.pathSeparator}frame1.arw',
            '${directory.path}${Platform.pathSeparator}frame2.arw',
          ],
          decoderRegistry: registryForRun(),
        );
        final LinearRawMosaic actual = await store.readFull();
        expect(actual.samples, orderedEquals(expected.samples));
        for (int i = 0; i < actual.samples.length; i++) {
          expect(
            actual.saturationMask?.isSaturatedIndex(i) ?? false,
            expected.saturationMask?.isSaturatedIndex(i) ?? false,
          );
        }
      } finally {
        await store?.dispose();
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'prepareMasterFlatStore: direct streamed output matches in-memory master',
    () async {
      final Directory directory = await _writeArwFiles(3);
      final List<List<double>> sourceSamples = <List<double>>[
        <double>[612, 712, 812, 912],
        <double>[622, 722, 822, 922],
        <double>[632, 732, 832, 932],
      ];
      RawDecoderRegistry registryForRun() => RawDecoderRegistry(<RawDecoder>[
            NativeRawDecoder(
              backend: _QueuedArwBackend(<RawNativeDecodedFrame>[
                for (final List<double> samples in sourceSamples)
                  _frame(samples),
              ]),
              supportedFormats: const <RawFormat>{RawFormat.arw},
              decoderId: 'test-arw',
            ),
          ]);
      FileBackedLinearRawMosaicStore? store;
      try {
        final LinearRawMosaic expected = await prepareMasterFlat(
          sourcePaths: <String>[
            '${directory.path}${Platform.pathSeparator}frame0.arw',
            '${directory.path}${Platform.pathSeparator}frame1.arw',
            '${directory.path}${Platform.pathSeparator}frame2.arw',
          ],
          decoderRegistry: registryForRun(),
        );
        store = await prepareMasterFlatStore(
          sourcePaths: <String>[
            '${directory.path}${Platform.pathSeparator}frame0.arw',
            '${directory.path}${Platform.pathSeparator}frame1.arw',
            '${directory.path}${Platform.pathSeparator}frame2.arw',
          ],
          decoderRegistry: registryForRun(),
        );
        final LinearRawMosaic actual = await store.readFull();
        expect(actual.samples, orderedEquals(expected.samples));
        for (int i = 0; i < actual.samples.length; i++) {
          expect(
            actual.saturationMask?.isSaturatedIndex(i) ?? false,
            expected.saturationMask?.isSaturatedIndex(i) ?? false,
          );
        }
      } finally {
        await store?.dispose();
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'prepareMasterDarkStore: empty sourcePaths preserves InvalidDarkFrameInput',
    () async {
      await expectLater(
        prepareMasterDarkStore(
          sourcePaths: const <String>[],
          decoderRegistry: RawDecoderRegistry(<RawDecoder>[]),
        ),
        throwsA(isA<InvalidDarkFrameInput>()),
      );
    },
  );
}
