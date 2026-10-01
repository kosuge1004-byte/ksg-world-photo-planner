import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/quality/processing_precision.dart';
import 'package:mobile_stack/core/raw/native_raw_decoder.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';
import 'package:mobile_stack/core/raw/raw_probe_result.dart';

class _FakeNativeBackend implements RawNativeDecodeBackend {
  _FakeNativeBackend(this.frame);

  final RawNativeDecodedFrame frame;
  RawNativeDecodeCommand? lastCommand;

  @override
  Future<RawNativeDecodedFrame> decode(
    RawNativeDecodeCommand command,
  ) async {
    lastCommand = command;
    return frame;
  }
}

final class _FakeRawSampleLease implements RawSampleLease {
  bool released = false;

  @override
  bool get isReleased => released;

  @override
  void release() {
    released = true;
  }
}

RawNativeDecodedFrame _frame({
  RawFormat format = RawFormat.dng,
  int width = 2,
  int height = 2,
  List<double> samples = const <double>[100, 200, 300, 400],
  RawActiveArea? activeArea,
  int orientation = 1,
  List<double> blackLevels = const <double>[64, 64, 64, 64],
  double whiteLevel = 16383,
  List<double>? cameraWhiteBalance = const <double>[2, 1, 1, 1.5],
}) {
  return RawNativeDecodedFrame(
    format: format,
    width: width,
    height: height,
    cfaPattern: CfaPattern.rggb,
    activeArea: activeArea ??
        RawActiveArea(
          left: 0,
          top: 0,
          width: width,
          height: height,
        ),
    orientation: orientation,
    blackLevels: blackLevels,
    whiteLevel: whiteLevel,
    cameraWhiteBalance: cameraWhiteBalance,
    samples: Float32List.fromList(samples),
  );
}

RawProbeResult _probe() => const RawProbeResult(
      path: '/images/input.dng',
      format: RawFormat.dng,
      byteLength: 4096,
      isReadable: true,
      signatureMatched: true,
    );

void main() {
  test('ネイティブ結果を所有権独立のLinearRawMosaicへ変換する', () async {
    final _FakeNativeBackend backend = _FakeNativeBackend(_frame());
    final NativeRawDecoder decoder = NativeRawDecoder(
      backend: backend,
      supportedFormats: const <RawFormat>[RawFormat.dng, RawFormat.nef],
    );

    final RawDecodeResult result = await decoder.decode(
      RawDecodeRequest(probe: _probe()),
    );

    expect(result.mosaic.width, 2);
    expect(result.mosaic.height, 2);
    expect(result.mosaic.samples, orderedEquals(<double>[100, 200, 300, 400]));
    expect(
        result.metadata.blackLevels, orderedEquals(<double>[64, 64, 64, 64]));
    expect(result.metadata.cameraWhiteBalance, isNotNull);
    expect(backend.lastCommand!.expectedByteLength, 4096);
    expect(backend.lastCommand!.maximumPixelCount, 64000000);
  });

  test('入力と異なるRAW形式を返したネイティブ結果を拒否する', () async {
    final NativeRawDecoder decoder = NativeRawDecoder(
      backend: _FakeNativeBackend(_frame(format: RawFormat.nef)),
      supportedFormats: const <RawFormat>[RawFormat.dng],
    );

    expect(
      decoder.decode(RawDecodeRequest(probe: _probe())),
      throwsA(
        isA<RawDecodeFailure>().having(
          (RawDecodeFailure error) => error.code,
          'code',
          RawDecodeErrorCode.corruptData,
        ),
      ),
    );
  });

  test('画素数上限を超えた結果を品質低下させず拒否する', () async {
    final NativeRawDecoder decoder = NativeRawDecoder(
      backend: _FakeNativeBackend(_frame()),
      supportedFormats: const <RawFormat>[RawFormat.dng],
    );

    expect(
      decoder.decode(
        RawDecodeRequest(
          probe: _probe(),
          maximumPixelCount: 3,
        ),
      ),
      throwsA(
        isA<RawDecodeFailure>().having(
          (RawDecodeFailure error) => error.code,
          'code',
          RawDecodeErrorCode.resourceLimit,
        ),
      ),
    );
  });

  test('ABI v1でFP32以外の出力要求を拒否する', () async {
    final NativeRawDecoder decoder = NativeRawDecoder(
      backend: _FakeNativeBackend(_frame()),
      supportedFormats: const <RawFormat>[RawFormat.dng],
    );

    expect(
      decoder.decode(
        RawDecodeRequest(
          probe: _probe(),
          outputPrecision: ProcessingPrecision.float64,
        ),
      ),
      throwsA(
        isA<RawDecodeFailure>().having(
          (RawDecodeFailure error) => error.code,
          'code',
          RawDecodeErrorCode.invalidArgument,
        ),
      ),
    );
  });

  test('非有限値を含むネイティブ画素バッファを拒否する', () async {
    final NativeRawDecoder decoder = NativeRawDecoder(
      backend: _FakeNativeBackend(
        _frame(samples: <double>[100, double.nan, 300, 400]),
      ),
      supportedFormats: const <RawFormat>[RawFormat.dng],
    );

    expect(
      decoder.decode(RawDecodeRequest(probe: _probe())),
      throwsA(
        isA<RawDecodeFailure>().having(
          (RawDecodeFailure error) => error.code,
          'code',
          RawDecodeErrorCode.corruptData,
        ),
      ),
    );
  });

  test('crops the active area and normalizes orientation with CFA phases',
      () async {
    final NativeRawDecoder decoder = NativeRawDecoder(
      backend: _FakeNativeBackend(
        _frame(
          width: 6,
          height: 4,
          samples: <double>[
            for (int index = 0; index < 24; index++) index.toDouble(),
          ],
          activeArea: const RawActiveArea(
            left: 1,
            top: 1,
            width: 4,
            height: 2,
          ),
          orientation: 8,
          blackLevels: const <double>[10, 20, 30, 40],
          cameraWhiteBalance: const <double>[1, 2, 3, 4],
        ),
      ),
      supportedFormats: const <RawFormat>[RawFormat.dng],
    );

    final RawDecodeResult result = await decoder.decode(
      RawDecodeRequest(probe: _probe()),
    );

    expect(result.mosaic.width, 2);
    expect(result.mosaic.height, 4);
    expect(result.mosaic.cfaPattern, CfaPattern.grbg);
    expect(
      result.mosaic.samples,
      orderedEquals(<double>[10, 16, 9, 15, 8, 14, 7, 13]),
    );
    expect(result.metadata.activeArea.left, 0);
    expect(result.metadata.activeArea.top, 0);
    expect(result.metadata.activeArea.width, 2);
    expect(result.metadata.activeArea.height, 4);
    expect(result.metadata.orientation, 1);
    expect(
      result.metadata.blackLevels,
      orderedEquals(<double>[30, 10, 40, 20]),
    );
    expect(
      result.metadata.cameraWhiteBalance,
      orderedEquals(<double>[3, 1, 4, 2]),
    );
  });

  test('captures sensor saturation before calibration and orientation',
      () async {
    final NativeRawDecoder decoder = NativeRawDecoder(
      backend: _FakeNativeBackend(
        _frame(
          width: 6,
          height: 4,
          samples: <double>[
            for (int index = 0; index < 24; index++)
              index == 10 || index == 16 ? 100 : index.toDouble(),
          ],
          activeArea: const RawActiveArea(
            left: 1,
            top: 1,
            width: 4,
            height: 2,
          ),
          orientation: 8,
          whiteLevel: 100,
        ),
      ),
      supportedFormats: const <RawFormat>[RawFormat.dng],
    );

    final RawDecodeResult result = await decoder.decode(
      RawDecodeRequest(probe: _probe()),
    );

    expect(result.mosaic.saturationMask, isNotNull);
    expect(result.mosaic.saturationMask!.saturatedCount, 2);
    expect(result.mosaic.isSaturatedAt(0, 0), isTrue);
    expect(result.mosaic.isSaturatedAt(1, 0), isTrue);
    expect(result.mosaic.isSaturatedAt(0, 1), isFalse);
  });

  test('all TIFF orientations crop in place in the decoder-owned buffer',
      () async {
    final List<double> source = <double>[
      for (int index = 0; index < 24; index++) index.toDouble(),
    ];

    for (int orientation = 1; orientation <= 8; orientation++) {
      final RawNativeDecodedFrame frame = _frame(
        width: 6,
        height: 4,
        samples: source,
        activeArea: const RawActiveArea(
          left: 1,
          top: 1,
          width: 4,
          height: 2,
        ),
        orientation: orientation,
      );
      final NativeRawDecoder decoder = NativeRawDecoder(
        backend: _FakeNativeBackend(frame),
        supportedFormats: const <RawFormat>[RawFormat.dng],
      );

      final RawDecodeResult result = await decoder.decode(
        RawDecodeRequest(probe: _probe()),
      );
      final bool swapsAxes = orientation >= 5;
      final int outputWidth = swapsAxes ? 2 : 4;
      final int outputHeight = swapsAxes ? 4 : 2;
      final List<double> expected = <double>[];
      for (int y = 0; y < outputHeight; y++) {
        for (int x = 0; x < outputWidth; x++) {
          final (int localX, int localY) = switch (orientation) {
            1 => (x, y),
            2 => (3 - x, y),
            3 => (3 - x, 1 - y),
            4 => (x, 1 - y),
            5 => (y, x),
            6 => (y, 1 - x),
            7 => (3 - y, 1 - x),
            8 => (3 - y, x),
            _ => throw StateError('unreachable'),
          };
          expected.add(source[(1 + localY) * 6 + 1 + localX]);
        }
      }

      expect(result.mosaic.width, outputWidth);
      expect(result.mosaic.height, outputHeight);
      expect(result.mosaic.samples, orderedEquals(expected));
      frame.samples[0] = 999;
      expect(result.mosaic.samples[0], 999);
    }
  });

  test('propagates native sample lease without changing samples', () async {
    final _FakeRawSampleLease lease = _FakeRawSampleLease();
    final RawNativeDecodedFrame frame = RawNativeDecodedFrame.takeOwnedSamples(
      format: RawFormat.arw,
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
      orientation: 1,
      blackLevels: const <double>[0, 0, 0, 0],
      whiteLevel: 4095,
      samples: Float32List.fromList(<double>[1, 2, 3, 4]),
      sampleLease: lease,
    );
    final NativeRawDecoder decoder = NativeRawDecoder(
      backend: _FakeNativeBackend(frame),
      supportedFormats: const <RawFormat>{RawFormat.arw},
    );
    final RawDecodeResult decoded = await decoder.decode(
      RawDecodeRequest(
        probe: const RawProbeResult(
          path: '/tmp/test.arw',
          format: RawFormat.arw,
          byteLength: 4,
          isReadable: true,
          signatureMatched: true,
        ),
      ),
    );
    expect(decoded.sampleLease, same(lease));
    expect(decoded.mosaic.samples, orderedEquals(<double>[1, 2, 3, 4]));
    expect(lease.isReleased, isFalse);
  });
}
