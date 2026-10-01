import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/raw_saturation_mask.dart';
import '../quality/processing_precision.dart';
import 'raw_decoder_contract.dart';
import 'raw_format.dart';
import 'raw_native_contract.dart';

/// ネイティブFFIバックエンドを既存のRawDecoder契約へ接続する。
class NativeRawDecoder implements RawDecoder, RawFileBackedDecoder {
  NativeRawDecoder({
    required this.backend,
    required Iterable<RawFormat> supportedFormats,
    this.decoderId = 'mobile-stack-native-raw-v1',
  }) : descriptor = RawDecodeDescriptor(
          supportedFormats: supportedFormats,
          decoderId: decoderId,
          nativeBackendRequired: true,
          minimumAbiVersion: rawNativeAbiVersion,
          maximumAbiVersion: rawNativeAbiVersion,
        );

  final RawNativeDecodeBackend backend;
  final String decoderId;

  @override
  final RawDecodeDescriptor descriptor;

  @override
  bool supports(RawFormat format) {
    return descriptor.supportedFormats.contains(format);
  }

  @override
  Future<RawDecodeResult> decode(RawDecodeRequest request) async {
    if (!request.probe.isAccepted) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: '検査を通過していないRAWはデコードできません。',
      );
    }
    if (!supports(request.probe.format)) {
      throw RawDecodeFailure(
        code: RawDecodeErrorCode.unsupportedFormat,
        message: '${request.probe.format.label}はこのデコーダーの対象外です。',
      );
    }
    if (request.outputPrecision != ProcessingPrecision.float32) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: 'Native RAW ABI v1の出力精度はFP32固定です。',
      );
    }

    final RawNativeDecodedFrame frame = await backend.decode(
      RawNativeDecodeCommand(
        path: request.probe.path,
        expectedFormat: request.probe.format,
        expectedByteLength: request.probe.byteLength,
        outputPrecision: request.outputPrecision,
        maximumPixelCount: request.maximumPixelCount,
      ),
    );
    _validateFrame(frame, request);

    final _NormalizedRawFrame normalized = _normalizeFrame(frame);
    return RawDecodeResult(
      mosaic: normalized.mosaic,
      metadata: RawFrameMetadata(
        format: frame.format,
        activeArea: RawActiveArea(
          left: 0,
          top: 0,
          width: normalized.mosaic.width,
          height: normalized.mosaic.height,
        ),
        orientation: 1,
        blackLevels: normalized.blackLevels,
        whiteLevel: frame.whiteLevel,
        cameraWhiteBalance: normalized.cameraWhiteBalance,
      ),
      decoderId: decoderId,
      sampleLease: frame.sampleLease,
    );
  }

  @override
  bool get supportsFileBackedDecode => backend is RawNativeFileDecodeBackend;

  @override
  Future<RawFileBackedDecodeResult> decodeToFileBacked(
    RawDecodeRequest request, {
    required String outputPath,
  }) async {
    if (!request.probe.isAccepted) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: '検査を通過していないRAWはデコードできません。',
      );
    }
    if (!supports(request.probe.format)) {
      throw RawDecodeFailure(
        code: RawDecodeErrorCode.unsupportedFormat,
        message: '${request.probe.format.label}はこのデコーダーの対象外です。',
      );
    }
    if (request.outputPrecision != ProcessingPrecision.float32) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: 'Native RAW ABI v1の出力精度はFP32固定です。',
      );
    }
    final RawNativeFileDecodeBackend? fileBackend =
        backend is RawNativeFileDecodeBackend
            ? backend as RawNativeFileDecodeBackend
            : null;
    if (fileBackend == null) {
      throw const RawDecoderUnavailable(
        'このNative RAWバックエンドはファイルバックデコード非対応です。',
      );
    }

    final RawNativeFileDecodedFrame frame = await fileBackend.decodeToFile(
      command: RawNativeDecodeCommand(
        path: request.probe.path,
        expectedFormat: request.probe.format,
        expectedByteLength: request.probe.byteLength,
        outputPrecision: request.outputPrecision,
        maximumPixelCount: request.maximumPixelCount,
      ),
      outputPath: outputPath,
    );
    _validateFileFrame(frame, request);

    // Work300 deliberately exposes only geometry that does not require
    // full-frame in-memory crop/orientation normalization. Other RAWs safely
    // fall back to the established decode() path in callers.
    if (frame.activeArea.left != 0 ||
        frame.activeArea.top != 0 ||
        frame.activeArea.width != frame.width ||
        frame.activeArea.height != frame.height ||
        frame.orientation != 1) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.unsupportedFormat,
        message: 'このRAWはストリーム経路でActiveArea/Orientation正規化が必要です。',
      );
    }

    return RawFileBackedDecodeResult(
      samplePath: outputPath,
      width: frame.width,
      height: frame.height,
      cfaPattern: frame.cfaPattern,
      metadata: RawFrameMetadata(
        format: frame.format,
        activeArea: RawActiveArea(
          left: 0,
          top: 0,
          width: frame.width,
          height: frame.height,
        ),
        orientation: 1,
        blackLevels: frame.blackLevels,
        whiteLevel: frame.whiteLevel,
        cameraWhiteBalance: frame.cameraWhiteBalance,
      ),
      decoderId: decoderId,
    );
  }

  void _validateFileFrame(
    RawNativeFileDecodedFrame frame,
    RawDecodeRequest request,
  ) {
    if (frame.format != request.probe.format ||
        frame.width <= 0 ||
        frame.height <= 0 ||
        frame.width * frame.height > request.maximumPixelCount ||
        !frame.activeArea.fitsInside(frame.width, frame.height) ||
        frame.orientation < 1 ||
        frame.orientation > 8 ||
        frame.blackLevels.length != 4 ||
        frame.blackLevels.any((double value) => !value.isFinite) ||
        !frame.whiteLevel.isFinite ||
        frame.whiteLevel <= 0) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'Native RAWストリーム結果のメタデータが不正です。',
      );
    }
    final List<double>? wb = frame.cameraWhiteBalance;
    if (wb != null &&
        (wb.length != 4 ||
            wb.any((double value) => !value.isFinite || value <= 0))) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'Native RAWストリーム結果のWBが不正です。',
      );
    }
  }

  void _validateFrame(
    RawNativeDecodedFrame frame,
    RawDecodeRequest request,
  ) {
    if (frame.format != request.probe.format) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'ネイティブ結果のRAW形式が入力と一致しません。',
      );
    }
    if (frame.width <= 0 || frame.height <= 0) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'ネイティブ結果の画像寸法が不正です。',
      );
    }

    final int pixelCount = frame.width * frame.height;
    if (pixelCount > request.maximumPixelCount) {
      throw RawDecodeFailure(
        code: RawDecodeErrorCode.resourceLimit,
        message: 'RAW画素数が安全上限を超えています: $pixelCount',
      );
    }
    if (frame.samples.length != pixelCount) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'ネイティブ結果の画素数とバッファ長が一致しません。',
      );
    }
    if (!frame.activeArea.fitsInside(frame.width, frame.height)) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'RAWの有効領域が画像範囲外です。',
      );
    }
    if (frame.orientation < 1 || frame.orientation > 8) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'RAWのOrientation値が不正です。',
      );
    }
    if (frame.blackLevels.length != 4 ||
        frame.blackLevels.any((double value) => !value.isFinite) ||
        !frame.whiteLevel.isFinite ||
        frame.whiteLevel <= 0) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'RAWのブラック／ホワイトレベルが不正です。',
      );
    }

    final List<double>? whiteBalance = frame.cameraWhiteBalance;
    if (whiteBalance != null &&
        (whiteBalance.length != 4 ||
            whiteBalance.any(
              (double value) => !value.isFinite || value <= 0,
            ))) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'RAWのカメラホワイトバランス値が不正です。',
      );
    }
  }
}

final class _NormalizedRawFrame {
  const _NormalizedRawFrame({
    required this.mosaic,
    required this.blackLevels,
    required this.cameraWhiteBalance,
  });

  final LinearRawMosaic mosaic;
  final List<double> blackLevels;
  final List<double>? cameraWhiteBalance;
}

_NormalizedRawFrame _normalizeFrame(RawNativeDecodedFrame frame) {
  final RawActiveArea active = frame.activeArea;
  if (active.left == 0 &&
      active.top == 0 &&
      active.width == frame.width &&
      active.height == frame.height &&
      frame.orientation == 1) {
    return _NormalizedRawFrame(
      mosaic: LinearRawMosaic(
        width: frame.width,
        height: frame.height,
        cfaPattern: frame.cfaPattern,
        samples: frame.samples,
        saturationMask: _captureSaturationMask(
          frame.samples,
          frame.whiteLevel,
        ),
      ),
      blackLevels: frame.blackLevels,
      cameraWhiteBalance: frame.cameraWhiteBalance,
    );
  }

  final bool swapsAxes = frame.orientation >= 5;
  final int outputWidth = swapsAxes ? active.height : active.width;
  final int outputHeight = swapsAxes ? active.width : active.height;
  final List<int> sourcePhases = <int>[];
  final List<int> colors = <int>[];
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      final int sourceIndex = _normalizedSourceIndex(frame, x, y);
      final int sourceY = sourceIndex ~/ frame.width;
      final int sourceX = sourceIndex - sourceY * frame.width;
      sourcePhases.add(((sourceY & 1) << 1) | (sourceX & 1));
      colors.add(_cfaColor(frame.cfaPattern, sourceX, sourceY));
    }
  }
  final CfaPattern outputPattern = _patternForColors(colors);
  final List<double> normalizedBlackLevels = <double>[
    for (final int phase in sourcePhases) frame.blackLevels[phase],
  ];
  final List<double>? normalizedWhiteBalance = frame.cameraWhiteBalance == null
      ? null
      : <double>[
          for (final int phase in sourcePhases)
            frame.cameraWhiteBalance![phase],
        ];
  final Float32List samples = _normalizeOwnedSamplesInPlace(
    frame,
    outputWidth: outputWidth,
    outputHeight: outputHeight,
  );
  return _NormalizedRawFrame(
    mosaic: LinearRawMosaic(
      width: outputWidth,
      height: outputHeight,
      cfaPattern: outputPattern,
      samples: samples,
      saturationMask: _captureSaturationMask(samples, frame.whiteLevel),
    ),
    blackLevels: normalizedBlackLevels,
    cameraWhiteBalance: normalizedWhiteBalance,
  );
}

/// Crops and orients the decoder-owned sample buffer without allocating a
/// second full-resolution plane. The target-to-source mapping is injective, so
/// its dependency graph consists only of disjoint paths and cycles. Paths are
/// copied from their no-predecessor end; cycles retain one scalar while being
/// rotated. One compact visited bit set is the only size-dependent scratch
/// storage. Whether an output slot has a predecessor is derived directly from
/// whether that storage slot lies in ActiveArea, avoiding a second bit set.
@pragma('vm:never-inline')
Float32List _normalizeOwnedSamplesInPlace(
  RawNativeDecodedFrame frame, {
  required int outputWidth,
  required int outputHeight,
}) {
  final Float32List storage = frame.samples;
  final RawActiveArea active = frame.activeArea;
  final int outputCount = outputWidth * outputHeight;
  final Float32List normalizedView =
      Float32List.sublistView(storage, 0, outputCount);
  final Uint8List visited = Uint8List((outputCount + 7) >> 3);

  for (int start = 0; start < outputCount; start++) {
    if (_hasNormalizationPredecessor(start, frame.width, active) ||
        _isNormalizationBitMarked(visited, start)) {
      continue;
    }
    int current = start;
    while (
        current < outputCount && !_isNormalizationBitMarked(visited, current)) {
      final int source =
          _normalizationSourceIndex(frame, current, outputWidth, active);
      _markNormalizationBit(visited, current);
      storage[current] = storage[source];
      current = source;
    }
  }

  for (int start = 0; start < outputCount; start++) {
    if (_isNormalizationBitMarked(visited, start)) continue;
    final double saved = storage[start];
    int current = start;
    while (true) {
      final int source =
          _normalizationSourceIndex(frame, current, outputWidth, active);
      _markNormalizationBit(visited, current);
      if (source == start) {
        storage[current] = saved;
        break;
      }
      if (source >= outputCount || _isNormalizationBitMarked(visited, source)) {
        throw StateError('RAW normalization dependency graph is invalid.');
      }
      storage[current] = storage[source];
      current = source;
    }
  }

  return normalizedView;
}

@pragma('vm:prefer-inline')
bool _hasNormalizationPredecessor(
  int targetIndex,
  int sourceRowStride,
  RawActiveArea active,
) {
  final int y = targetIndex ~/ sourceRowStride;
  final int x = targetIndex - y * sourceRowStride;
  return x >= active.left &&
      x < active.left + active.width &&
      y >= active.top &&
      y < active.top + active.height;
}

@pragma('vm:prefer-inline')
int _normalizationSourceIndex(
  RawNativeDecodedFrame frame,
  int targetIndex,
  int outputWidth,
  RawActiveArea active,
) {
  final int y = targetIndex ~/ outputWidth;
  final int x = targetIndex - y * outputWidth;
  final int sourceRowStride = frame.width;
  return switch (frame.orientation) {
    1 => (active.top + y) * sourceRowStride + active.left + x,
    2 =>
      (active.top + y) * sourceRowStride + active.left + active.width - 1 - x,
    3 => (active.top + active.height - 1 - y) * sourceRowStride +
        active.left +
        active.width -
        1 -
        x,
    4 =>
      (active.top + active.height - 1 - y) * sourceRowStride + active.left + x,
    5 => (active.top + x) * sourceRowStride + active.left + y,
    6 =>
      (active.top + active.height - 1 - x) * sourceRowStride + active.left + y,
    7 => (active.top + active.height - 1 - x) * sourceRowStride +
        active.left +
        active.width -
        1 -
        y,
    8 =>
      (active.top + x) * sourceRowStride + active.left + active.width - 1 - y,
    _ => throw StateError('Unsupported RAW orientation ${frame.orientation}.'),
  };
}

@pragma('vm:prefer-inline')
bool _isNormalizationBitMarked(Uint8List bits, int index) =>
    (bits[index >> 3] & (1 << (index & 7))) != 0;

@pragma('vm:prefer-inline')
void _markNormalizationBit(Uint8List bits, int index) {
  bits[index >> 3] |= 1 << (index & 7);
}

RawSaturationMask _captureSaturationMask(
  Float32List samples,
  double whiteLevel,
) {
  try {
    return RawSaturationMask.fromFiniteFloat32Threshold(samples, whiteLevel);
  } on StateError {
    throw const RawDecodeFailure(
      code: RawDecodeErrorCode.corruptData,
      message: 'RAW画素バッファに非有限値が含まれています。',
    );
  }
}

int _normalizedSourceIndex(RawNativeDecodedFrame frame, int x, int y) {
  final RawActiveArea active = frame.activeArea;
  return switch (frame.orientation) {
    1 => (active.top + y) * frame.width + active.left + x,
    2 => (active.top + y) * frame.width + active.left + active.width - 1 - x,
    3 => (active.top + active.height - 1 - y) * frame.width +
        active.left +
        active.width -
        1 -
        x,
    4 => (active.top + active.height - 1 - y) * frame.width + active.left + x,
    5 => (active.top + x) * frame.width + active.left + y,
    6 => (active.top + active.height - 1 - x) * frame.width + active.left + y,
    7 => (active.top + active.height - 1 - x) * frame.width +
        active.left +
        active.width -
        1 -
        y,
    8 => (active.top + x) * frame.width + active.left + active.width - 1 - y,
    _ => throw StateError('Unsupported RAW orientation ${frame.orientation}.'),
  };
}

int _cfaColor(CfaPattern pattern, int x, int y) {
  final bool evenX = x.isEven;
  final bool evenY = y.isEven;
  return switch (pattern) {
    CfaPattern.rggb => evenX && evenY ? 0 : (!evenX && !evenY ? 2 : 1),
    CfaPattern.bggr => evenX && evenY ? 2 : (!evenX && !evenY ? 0 : 1),
    CfaPattern.grbg => !evenX && evenY ? 0 : (evenX && !evenY ? 2 : 1),
    CfaPattern.gbrg => evenX && !evenY ? 0 : (!evenX && evenY ? 2 : 1),
  };
}

CfaPattern _patternForColors(List<int> colors) => switch (colors) {
      <int>[0, 1, 1, 2] => CfaPattern.rggb,
      <int>[2, 1, 1, 0] => CfaPattern.bggr,
      <int>[1, 0, 2, 1] => CfaPattern.grbg,
      <int>[1, 2, 0, 1] => CfaPattern.gbrg,
      _ => throw StateError('RAW orientation produced an invalid CFA phase.'),
    };
