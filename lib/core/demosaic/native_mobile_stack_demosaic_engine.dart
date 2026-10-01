import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/raw_saturation_mask.dart';
import '../quality/highest_quality_policy.dart';
import '../tiles/overlapped_tile_plan.dart';
import '../image/linear_rgb_tile.dart';
import 'demosaic_algorithm.dart';
import 'demosaic_engine.dart';
import 'demosaic_request.dart';

const int _apiVersion = 3;
const int _statusOk = 0;
const int _statusInvalidArgument = 1;
const int _statusUnsupportedCfa = 2;
const int _statusCancelled = 3;
const int _statusNonfinite = 4;

final class _NativeDemosaicRequest extends Struct {
  @Uint32()
  external int apiVersion;

  @Uint32()
  external int structSize;

  external Pointer<Float> cfaSamples;

  @Uint32()
  external int imageWidth;

  @Uint32()
  external int imageHeight;

  @Uint32()
  external int cfaRowStrideSamples;

  @Uint32()
  external int cfaBufferX;

  @Uint32()
  external int cfaBufferY;

  @Uint32()
  external int cfaBufferWidth;

  @Uint32()
  external int cfaBufferHeight;

  @Uint32()
  external int cfaPattern;

  @Uint32()
  external int inputX;

  @Uint32()
  external int inputY;

  @Uint32()
  external int inputWidth;

  @Uint32()
  external int inputHeight;

  @Uint32()
  external int outputX;

  @Uint32()
  external int outputY;

  @Uint32()
  external int outputWidth;

  @Uint32()
  external int outputHeight;

  external Pointer<Float> outputRgb;

  @Uint32()
  external int outputRowStrideFloats;

  external Pointer<NativeFunction<Int32 Function(Pointer<Void>)>>
      cancelCallback;

  external Pointer<Void> cancelContext;

  external Pointer<Uint8> saturationMask;

  @Uint32()
  external int saturationRowStrideBits;
}

typedef _ApiVersionNative = Uint32 Function();
typedef _ApiVersionDart = int Function();
typedef _DemosaicNative = Int32 Function(Pointer<_NativeDemosaicRequest>);
typedef _DemosaicDart = int Function(Pointer<_NativeDemosaicRequest>);

final class NativeMobileStackDemosaicEngine
    implements DemosaicEngine, DisposableDemosaicEngine {
  NativeMobileStackDemosaicEngine({DynamicLibrary? library})
      : _library = library;

  DynamicLibrary? _library;
  _DemosaicDart? _demosaic;
  Object? _cachedSaturationMaskOwner;
  Pointer<Uint8>? _cachedSaturationMask;

  @override
  DemosaicAlgorithm get algorithm => DemosaicAlgorithm.mobileStackAdaptive;

  static const int nativeRequiredInputRadius = 5;

  @override
  int get requiredInputRadius => nativeRequiredInputRadius;

  @override
  bool get isProductionQuality {
    try {
      _resolveDemosaic();
      return true;
    } on Object {
      return false;
    }
  }

  DynamicLibrary _openLibrary() {
    final DynamicLibrary? existing = _library;
    if (existing != null) return existing;
    try {
      final DynamicLibrary opened = Platform.isIOS || Platform.isMacOS
          ? DynamicLibrary.process()
          : DynamicLibrary.open('libmobile_stack_raw.so');
      _library = opened;
      return opened;
    } on Object catch (error) {
      throw DemosaicBackendUnavailable(
        'Unable to open the native adaptive demosaic backend: $error',
      );
    }
  }

  _DemosaicDart _resolveDemosaic() {
    final _DemosaicDart? existing = _demosaic;
    if (existing != null) return existing;
    final DynamicLibrary library = _openLibrary();
    final _ApiVersionDart version =
        library.lookupFunction<_ApiVersionNative, _ApiVersionDart>(
      'mobile_stack_demosaic_api_version',
    );
    if (version() != _apiVersion) {
      throw const DemosaicBackendUnavailable(
        'Native adaptive demosaic API version is incompatible.',
      );
    }
    final _DemosaicDart resolved =
        library.lookupFunction<_DemosaicNative, _DemosaicDart>(
      'mobile_stack_demosaic_adaptive_tile',
    );
    _demosaic = resolved;
    return resolved;
  }

  Pointer<Float> _copyInputTile(DemosaicRequest request) {
    final int width = request.tile.inputWidth;
    final int height = request.tile.inputHeight;
    final Pointer<Float> samples = calloc<Float>(width * height);
    final Float32List target = samples.asTypedList(width * height);
    final Float32List source = request.mosaic.samples;
    final int sourceWidth = request.mosaic.width;
    final int x0 = request.tile.inputX;
    final int y0 = request.tile.inputY;
    for (int row = 0; row < height; row++) {
      final int sourceStart = (y0 + row) * sourceWidth + x0;
      final int targetStart = row * width;
      target.setRange(
        targetStart,
        targetStart + width,
        source,
        sourceStart,
      );
    }
    return samples;
  }

  Pointer<Uint8> _saturationMaskFor(LinearRawMosaic mosaic) {
    final RawSaturationMask? mask = mosaic.saturationMask;
    if (mask == null) return nullptr;
    return _saturationMaskForOwner(mosaic, mask);
  }

  Pointer<Uint8> _saturationMaskForStandalone(RawSaturationMask? mask) {
    if (mask == null) return nullptr;
    return _saturationMaskForOwner(mask, mask);
  }

  Pointer<Uint8> _saturationMaskForOwner(
    Object owner,
    RawSaturationMask mask,
  ) {
    final Pointer<Uint8>? existing = _cachedSaturationMask;
    if (identical(_cachedSaturationMaskOwner, owner) && existing != null) {
      return existing;
    }
    if (existing != null) calloc.free(existing);
    final Pointer<Uint8> nativeMask = calloc<Uint8>(mask.packedByteLength);
    mask.copyPackedBytesTo(nativeMask.asTypedList(mask.packedByteLength));
    _cachedSaturationMaskOwner = owner;
    _cachedSaturationMask = nativeMask;
    return nativeMask;
  }

  @override
  Future<LinearRgbTile> processTile(DemosaicRequest request) async {
    request.validate();
    if (request.cancellationRequested) {
      throw const DemosaicProcessingCancelled();
    }
    final int outputLength =
        request.tile.outputWidth * request.tile.outputHeight * 3;
    final Pointer<Float> input = _copyInputTile(request);
    final Pointer<Float> output = calloc<Float>(outputLength);
    final Pointer<_NativeDemosaicRequest> nativeRequest =
        calloc<_NativeDemosaicRequest>();
    try {
      final _NativeDemosaicRequest fields = nativeRequest.ref;
      fields
        ..apiVersion = _apiVersion
        ..structSize = sizeOf<_NativeDemosaicRequest>()
        ..cfaSamples = input
        ..imageWidth = request.mosaic.width
        ..imageHeight = request.mosaic.height
        ..cfaRowStrideSamples = request.tile.inputWidth
        ..cfaBufferX = request.tile.inputX
        ..cfaBufferY = request.tile.inputY
        ..cfaBufferWidth = request.tile.inputWidth
        ..cfaBufferHeight = request.tile.inputHeight
        ..cfaPattern = _cfaCode(request.mosaic.cfaPattern)
        ..inputX = request.tile.inputX
        ..inputY = request.tile.inputY
        ..inputWidth = request.tile.inputWidth
        ..inputHeight = request.tile.inputHeight
        ..outputX = request.tile.outputX
        ..outputY = request.tile.outputY
        ..outputWidth = request.tile.outputWidth
        ..outputHeight = request.tile.outputHeight
        ..outputRgb = output
        ..outputRowStrideFloats = request.tile.outputWidth * 3
        ..cancelCallback = nullptr
        ..cancelContext = nullptr
        ..saturationMask = _saturationMaskFor(request.mosaic)
        ..saturationRowStrideBits = request.mosaic.width;
      final int status = _resolveDemosaic()(nativeRequest);
      if (status == _statusCancelled || request.cancellationRequested) {
        throw const DemosaicProcessingCancelled();
      }
      if (status != _statusOk) throw _failureFor(status);
      return LinearRgbTile(
        x: request.tile.outputX,
        y: request.tile.outputY,
        width: request.tile.outputWidth,
        height: request.tile.outputHeight,
        interleavedRgb: Float32List.fromList(
          output.asTypedList(outputLength),
        ),
      );
    } finally {
      calloc.free(nativeRequest);
      calloc.free(output);
      calloc.free(input);
    }
  }

  /// Production-only file-backed entry point used after RAW calibration.
  ///
  /// The backing store contains the complete calibrated CFA plane, but only
  /// the current tile input rectangle is materialized in Dart/native memory.
  /// Global image dimensions, CFA phase and tile coordinates remain identical
  /// to [processTile], so the native algorithm sees the same geometry.
  Future<LinearRgbTile> processFileBackedTile({
    required FileBackedLinearRawMosaicStore store,
    required OverlappedTile tile,
    required RawSaturationMask? saturationMask,
    HighestQualityPolicy qualityPolicy = const HighestQualityPolicy(),
    bool Function()? isCancelled,
  }) async {
    if (tile.outputX < 0 ||
        tile.outputY < 0 ||
        tile.outputWidth <= 0 ||
        tile.outputHeight <= 0 ||
        tile.inputX < 0 ||
        tile.inputY < 0 ||
        tile.inputWidth <= 0 ||
        tile.inputHeight <= 0 ||
        tile.outputX + tile.outputWidth > store.width ||
        tile.outputY + tile.outputHeight > store.height ||
        tile.inputX + tile.inputWidth > store.width ||
        tile.inputY + tile.inputHeight > store.height ||
        tile.inputX > tile.outputX ||
        tile.inputY > tile.outputY ||
        tile.inputX + tile.inputWidth < tile.outputX + tile.outputWidth ||
        tile.inputY + tile.inputHeight < tile.outputY + tile.outputHeight) {
      throw ArgumentError('Demosaic tile coordinates are invalid.');
    }
    if (saturationMask != null &&
        saturationMask.pixelCount != store.width * store.height) {
      throw ArgumentError(
          'Saturation mask count does not match stored mosaic.');
    }
    if (isCancelled?.call() ?? false) {
      throw const DemosaicProcessingCancelled();
    }

    final Float32List localSamples = await store.readRegion(
      x: tile.inputX,
      y: tile.inputY,
      width: tile.inputWidth,
      height: tile.inputHeight,
    );
    if (isCancelled?.call() ?? false) {
      throw const DemosaicProcessingCancelled();
    }
    return _processLocalBuffer(
      samples: localSamples,
      imageWidth: store.width,
      imageHeight: store.height,
      cfaPattern: store.cfaPattern,
      tile: tile,
      saturationMask: saturationMask,
      isCancelled: isCancelled,
    );
  }

  Future<LinearRgbTile> _processLocalBuffer({
    required Float32List samples,
    required int imageWidth,
    required int imageHeight,
    required CfaPattern cfaPattern,
    required OverlappedTile tile,
    required RawSaturationMask? saturationMask,
    bool Function()? isCancelled,
  }) async {
    final int expectedSamples = tile.inputWidth * tile.inputHeight;
    if (samples.length != expectedSamples) {
      throw StateError('Local CFA tile sample count is invalid.');
    }
    final int outputLength = tile.outputWidth * tile.outputHeight * 3;
    final Pointer<Float> input = calloc<Float>(expectedSamples);
    input.asTypedList(expectedSamples).setAll(0, samples);
    final Pointer<Float> output = calloc<Float>(outputLength);
    final Pointer<_NativeDemosaicRequest> nativeRequest =
        calloc<_NativeDemosaicRequest>();
    try {
      final Pointer<Uint8> nativeMask =
          _saturationMaskForStandalone(saturationMask);
      final _NativeDemosaicRequest fields = nativeRequest.ref;
      fields
        ..apiVersion = _apiVersion
        ..structSize = sizeOf<_NativeDemosaicRequest>()
        ..cfaSamples = input
        ..imageWidth = imageWidth
        ..imageHeight = imageHeight
        ..cfaRowStrideSamples = tile.inputWidth
        ..cfaBufferX = tile.inputX
        ..cfaBufferY = tile.inputY
        ..cfaBufferWidth = tile.inputWidth
        ..cfaBufferHeight = tile.inputHeight
        ..cfaPattern = _cfaCode(cfaPattern)
        ..inputX = tile.inputX
        ..inputY = tile.inputY
        ..inputWidth = tile.inputWidth
        ..inputHeight = tile.inputHeight
        ..outputX = tile.outputX
        ..outputY = tile.outputY
        ..outputWidth = tile.outputWidth
        ..outputHeight = tile.outputHeight
        ..outputRgb = output
        ..outputRowStrideFloats = tile.outputWidth * 3
        ..cancelCallback = nullptr
        ..cancelContext = nullptr
        ..saturationMask = nativeMask
        ..saturationRowStrideBits = imageWidth;
      final int status = _resolveDemosaic()(nativeRequest);
      if (status == _statusCancelled || (isCancelled?.call() ?? false)) {
        throw const DemosaicProcessingCancelled();
      }
      if (status != _statusOk) throw _failureFor(status);
      return LinearRgbTile(
        x: tile.outputX,
        y: tile.outputY,
        width: tile.outputWidth,
        height: tile.outputHeight,
        interleavedRgb: Float32List.fromList(
          output.asTypedList(outputLength),
        ),
      );
    } finally {
      calloc.free(nativeRequest);
      calloc.free(output);
      calloc.free(input);
    }
  }

  @override
  void disposeTransientResources() {
    final Pointer<Uint8>? saturationMask = _cachedSaturationMask;
    if (saturationMask != null) calloc.free(saturationMask);
    _cachedSaturationMask = null;
    _cachedSaturationMaskOwner = null;
  }
}

int _cfaCode(CfaPattern pattern) => switch (pattern) {
      CfaPattern.rggb => 1,
      CfaPattern.bggr => 2,
      CfaPattern.grbg => 3,
      CfaPattern.gbrg => 4,
    };

Exception _failureFor(int status) => switch (status) {
      _statusInvalidArgument => const DemosaicBackendUnavailable(
          'Native adaptive demosaic rejected the tile request.',
        ),
      _statusUnsupportedCfa => const DemosaicBackendUnavailable(
          'Native adaptive demosaic does not support this CFA pattern.',
        ),
      _statusNonfinite => const DemosaicBackendUnavailable(
          'Native adaptive demosaic produced a non-finite sample.',
        ),
      _ => DemosaicBackendUnavailable(
          'Native adaptive demosaic failed with status $status.',
        ),
    };
