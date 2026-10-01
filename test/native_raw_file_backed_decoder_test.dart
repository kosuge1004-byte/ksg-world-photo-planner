import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/quality/processing_precision.dart';
import 'package:mobile_stack/core/raw/native_raw_decoder.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';
import 'package:mobile_stack/core/raw/raw_probe_result.dart';

final class _FakeFileBackend
    implements RawNativeDecodeBackend, RawNativeFileDecodeBackend {
  @override
  Future<RawNativeDecodedFrame> decode(RawNativeDecodeCommand command) =>
      throw UnimplementedError();

  @override
  Future<RawNativeFileDecodedFrame> decodeToFile({
    required RawNativeDecodeCommand command,
    required String outputPath,
  }) async {
    final file = File(outputPath);
    await file.writeAsBytes(
      const <int>[
        0, 0, 128, 66, // 64f
        0, 0, 128, 63, // 1f
        0, 0, 0, 64, // 2f
        0, 0, 64, 64, // 3f
      ],
      flush: true,
    );
    return RawNativeFileDecodedFrame(
      format: command.expectedFormat,
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
      orientation: 1,
      blackLevels: const <double>[64, 64, 64, 64],
      whiteLevel: 4095,
      samplePath: outputPath,
      cameraWhiteBalance: const <double>[2, 1, 1, 1.5],
    );
  }
}

void main() {
  test('NativeRawDecoder exposes no-full-frame file decode', () async {
    final decoder = NativeRawDecoder(
      backend: _FakeFileBackend(),
      supportedFormats: const <RawFormat>{RawFormat.arw},
    );
    final dir = await Directory.systemTemp.createTemp('work300-test-');
    try {
      final path = '${dir.path}/raw.f32';
      final result = await decoder.decodeToFileBacked(
        RawDecodeRequest(
          probe: RawProbeResult(
            path: 'fake.arw',
            format: RawFormat.arw,
            byteLength: 123,
            isReadable: true,
            signatureMatched: true,
            warning: null,
          ),
          outputPrecision: ProcessingPrecision.float32,
        ),
        outputPath: path,
      );
      expect(result.width, 2);
      expect(result.height, 2);
      expect(await File(path).length(), 16);
      expect(result.metadata.orientation, 1);
    } finally {
      await dir.delete(recursive: true);
    }
  });
}
