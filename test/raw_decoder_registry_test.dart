import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/quality/processing_precision.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_decoder_registry.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/native_raw_decoder_factory.dart';

class _FakeDecoder implements RawDecoder {
  @override
  RawDecodeDescriptor get descriptor => RawDecodeDescriptor(
        supportedFormats: const <RawFormat>[RawFormat.arw],
        decoderId: 'fake-arw',
        nativeBackendRequired: true,
        minimumAbiVersion: 1,
        maximumAbiVersion: 1,
      );

  @override
  bool supports(RawFormat format) => format == RawFormat.arw;

  @override
  Future<RawDecodeResult> decode(RawDecodeRequest request) async {
    expect(request.outputPrecision, ProcessingPrecision.float32);
    return RawDecodeResult(
      mosaic: LinearRawMosaic(
        width: 1,
        height: 1,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(<double>[0]),
      ),
      metadata: RawFrameMetadata(
        format: RawFormat.arw,
        activeArea: const RawActiveArea(
          left: 0,
          top: 0,
          width: 1,
          height: 1,
        ),
        orientation: 1,
        blackLevels: const <double>[0, 0, 0, 0],
        whiteLevel: 1,
      ),
      decoderId: 'fake-arw',
    );
  }
}

void main() {
  test('形式に対応するデコーダーを返す', () {
    final RawDecoderRegistry registry =
        RawDecoderRegistry(<RawDecoder>[_FakeDecoder()]);
    expect(registry.decoderFor(RawFormat.arw), isNotNull);
    expect(registry.decoderFor(RawFormat.cr3), isNull);
  });

  test('未登録形式は明示的な例外にする', () {
    final RawDecoderRegistry registry =
        RawDecoderRegistry(const <RawDecoder>[]);
    expect(
      () => registry.requireDecoder(RawFormat.nef),
      throwsA(isA<RawDecoderUnavailable>()),
    );
  });

  test('同じ形式のデコーダーを暗黙に上書きしない', () {
    expect(
      () => RawDecoderRegistry(
        <RawDecoder>[_FakeDecoder(), _FakeDecoder()],
      ),
      throwsStateError,
    );
  });

  test('Native ABI v1の全形式を登録する', () {
    final RawDecoderRegistry registry = createNativeRawDecoderRegistry();

    for (final RawFormat format in nativeRawAbiV1Formats) {
      expect(registry.decoderFor(format), isNotNull);
    }
    expect(registry.decoderFor(RawFormat.unknown), isNull);
  });

  test('本番画素デコーダーはSony ARWとNikon NEF/NRWを登録する', () {
    final RawDecoderRegistry registry =
        createProductionNativeRawDecoderRegistry();

    expect(registry.decoderFor(RawFormat.arw), isNotNull);
    expect(registry.decoderFor(RawFormat.nef), isNotNull);
    expect(registry.decoderFor(RawFormat.nrw), isNotNull);
    expect(registry.decoderFor(RawFormat.dng), isNull);
    expect(registry.decoderFor(RawFormat.cr3), isNull);
  });
}
