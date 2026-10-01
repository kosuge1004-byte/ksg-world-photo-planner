import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/quality/processing_precision.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';

void main() {
  test('Dart側のRAW形式コードをABI v1へ往復変換できる', () {
    for (final RawFormat format in RawFormat.values) {
      if (format == RawFormat.unknown) continue;
      expect(
        rawFormatFromNativeCode(rawFormatToNativeCode(format)),
        format,
      );
    }
  });

  test('ABI v1の精度とCFAコードを固定する', () {
    expect(
      precisionToNativeCode(ProcessingPrecision.float32),
      2,
    );
    expect(cfaPatternFromNativeCode(1), CfaPattern.rggb);
    expect(cfaPatternFromNativeCode(4), CfaPattern.gbrg);
    expect(cfaPatternFromNativeCode(99), isNull);
  });

  test('未知のネイティブ状態コードはinternalへ閉じる', () {
    expect(
      RawNativeStatus.fromCode(999),
      RawNativeStatus.internal,
    );
  });

  test('ABI v1の任意拡張能力ビットを固定する', () {
    expect(rawNativeCapabilityDecode, 1);
    expect(rawNativeCapabilityMetadataProbe, 2);
    expect(rawNativeCapabilityConformanceStub, 4);
    expect(rawNativeCapabilityDngMetadata, 8);
    expect(rawNativeCapabilityArwLosslessJpeg, 16);
    expect(rawNativeCapabilitySonyArw2, 32);
    expect(rawNativeCapabilityLibRawSony, 64);
    expect(rawNativeCapabilityLibRawNikon, 128);
  });

  test('ネイティブ由来サンプルをDart所有バッファへ複製する', () {
    final Float32List source = Float32List.fromList(<double>[1, 2, 3, 4]);
    final RawNativeDecodedFrame frame = RawNativeDecodedFrame(
      format: RawFormat.dng,
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
      blackLevels: const <double>[0, 0, 0, 0],
      whiteLevel: 1,
      samples: source,
    );

    source[0] = 99;

    expect(frame.samples[0], 1);
  });
  test('takeOwnedSamples avoids a second full-frame copy', () {
    final Float32List owned = Float32List.fromList(<double>[1, 2, 3, 4]);
    final RawNativeDecodedFrame frame = RawNativeDecodedFrame.takeOwnedSamples(
      format: RawFormat.arw,
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
      orientation: 1,
      blackLevels: const <double>[0, 0, 0, 0],
      whiteLevel: 4095,
      samples: owned,
    );

    expect(identical(frame.samples, owned), isTrue);
  });

  test('public constructor still isolates caller-owned samples', () {
    final Float32List caller = Float32List.fromList(<double>[1, 2, 3, 4]);
    final RawNativeDecodedFrame frame = RawNativeDecodedFrame(
      format: RawFormat.arw,
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
      orientation: 1,
      blackLevels: const <double>[0, 0, 0, 0],
      whiteLevel: 4095,
      samples: caller,
    );

    caller[0] = 99;
    expect(frame.samples[0], 1);
    expect(identical(frame.samples, caller), isFalse);
  });
}
