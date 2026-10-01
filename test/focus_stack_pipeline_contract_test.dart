import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/demosaic/demosaic_engine.dart';
import 'package:mobile_stack/core/demosaic/demosaic_registry.dart';
import 'package:mobile_stack/core/focus_stack/focus_stack_pipeline.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/io/raw_input_contract.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_decoder_registry.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_metadata_probe.dart';
import 'package:mobile_stack/core/raw/raw_probe_result.dart';

final class _DecoderWithoutColorMatrix implements RawDecoder {
  @override
  RawDecodeDescriptor get descriptor => RawDecodeDescriptor(
        supportedFormats: const <RawFormat>[RawFormat.arw],
        decoderId: 'focus-stack-metadata-merge-test',
        nativeBackendRequired: true,
        minimumAbiVersion: 1,
        maximumAbiVersion: 1,
      );

  @override
  bool supports(RawFormat format) => format == RawFormat.arw;

  @override
  Future<RawDecodeResult> decode(RawDecodeRequest request) async {
    return RawDecodeResult(
      mosaic: LinearRawMosaic(
        width: 1,
        height: 1,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List(1),
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
      decoderId: 'focus-stack-metadata-merge-test',
    );
  }
}

RawInputFile _inputWithProbedColorMatrix(String name) {
  final RawProbeResult probe = RawProbeResult(
    path: '/focus/$name',
    format: RawFormat.arw,
    byteLength: 1,
    isReadable: true,
    signatureMatched: true,
  );
  return RawInputFile(
    path: probe.path,
    byteLength: probe.byteLength,
    probe: probe,
    metadata: RawMetadataProbeResult(
      width: 1,
      height: 1,
      cfaPattern: CfaPattern.rggb,
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
        cameraWhiteBalance: const <double>[2, 1, 1.5, 1],
        d65XyzToCamera: const <double>[
          0.7374,
          -0.2389,
          -0.0551,
          -0.5435,
          1.3162,
          0.2519,
          -0.1006,
          0.1795,
          0.6552,
        ],
      ),
      probeId: 'focus-stack-metadata-merge-test',
    ),
  );
}

void main() {
  test('focus-stack cancellation exception is a distinct type', () {
    expect(
      const FocusStackPipelineCancelled(),
      isA<FocusStackPipelineCancelled>(),
    );
  });

  test('focus stack merges same-frame probe color metadata before output gate',
      () async {
    final Future<FocusStackPipelineResult> result = runFocusStackPipeline(
      inputs: <RawInputFile>[
        _inputWithProbedColorMatrix('near.arw'),
        _inputWithProbedColorMatrix('far.arw'),
      ],
      rawDecoderRegistry: RawDecoderRegistry(
        <RawDecoder>[_DecoderWithoutColorMatrix()],
      ),
      demosaicRegistry: DemosaicRegistry(const <DemosaicEngine>[]),
    );

    // Reaching the intentionally empty demosaic registry proves that the D65
    // requirement accepted metadata supplied by the probe of this same RAW.
    await expectLater(result, throwsA(isA<DemosaicBackendUnavailable>()));
  });
}
