import '../background/native_operation_trace.dart';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import '../image/cfa_pattern.dart';
import 'raw_decoder_contract.dart';
import 'raw_format.dart';
import 'raw_native_contract.dart';

// setpriority(2) binding used by [lowerCurrentThreadPriorityForBackgroundWork]
// below. `libc` symbols are already loaded into every Android/Linux process,
// so `DynamicLibrary.process()` resolves this without needing to modify or
// rebuild the bundled native decode library.
typedef _SetPriorityNative = Int32 Function(
  Int32 which,
  Int32 who,
  Int32 priority,
);
typedef _SetPriorityDart = int Function(int which, int who, int priority);

const int _prioProcess = 0; // PRIO_PROCESS
// Same nice value Android's own Process.THREAD_PRIORITY_BACKGROUND uses.
// Not "low enough to starve the worker forever" — just low enough that
// Linux's CFS scheduler always prefers a normal-priority thread (the
// foreground UI thread) over this one whenever both want the CPU at once.
const int _threadPriorityBackground = 10;

_SetPriorityDart? _setPriority;
bool _setPriorityLookupAttempted = false;

/// Lowers the *calling thread's* OS scheduling priority to the same level
/// Android uses for its own background threads, on a best-effort basis.
///
/// ## Why this exists
/// Moving native RAW decode calls onto their own isolate (see
/// [FfiRawDecodeWorker], [FfiRawDecodeBackgroundWorkerBackend]) stops that
/// call from blocking the Dart event loop of whatever isolate hosts a
/// watchdog `Timer` — a *Dart-level* fix. It does nothing about a distinct,
/// *OS-level* problem: the isolate still runs on an ordinary OS thread with
/// default (normal) scheduling priority, same as the app's UI thread. Under
/// sustained CPU load — exactly what a "maximum quality" multi-frame RAW
/// decode/demosaic run produces — Linux's scheduler has no reason to
/// prefer the foreground UI thread over this one, so the UI thread can
/// still miss its frame/input deadlines and trigger an Android ANR even
/// though no Dart code anywhere is "blocked" in the bug-fix sense.
///
/// Calling this once at the very start of the isolate that performs the
/// decode — before touching any native call — removes that possibility
/// structurally rather than probabilistically: with this thread demoted,
/// the scheduler always lets a normal-priority thread (the UI thread) run
/// first when both want the CPU, regardless of core count or how long the
/// decode call takes.
///
/// Failure here (unsupported platform, symbol not found, syscall
/// rejected) is silently ignored — this is a scheduling *hint*, and a
/// platform where it doesn't apply should fall back to previous behavior,
/// not fail the job.
void lowerCurrentThreadPriorityForBackgroundWork() {
  if (!Platform.isAndroid) return;
  if (!_setPriorityLookupAttempted) {
    _setPriorityLookupAttempted = true;
    try {
      _setPriority = DynamicLibrary.process()
          .lookupFunction<_SetPriorityNative, _SetPriorityDart>(
        'setpriority',
      );
    } on Object {
      _setPriority = null;
    }
  }
  try {
    // who=0 means "the calling thread" for PRIO_PROCESS on Linux, since
    // each thread is its own schedulable entity (task) under the hood —
    // the same mechanism Android's Process.setThreadPriority() uses.
    _setPriority?.call(_prioProcess, 0, _threadPriorityBackground);
  } on Object {
    // Best-effort; decoding must proceed even if this fails.
  }
}

final class MobileStackRawDecodeRequestNative extends Struct {
  @Uint32()
  external int abiVersion;

  @Uint32()
  external int structSize;

  @Uint32()
  external int expectedFormat;

  @Uint32()
  external int outputPrecision;

  @Uint32()
  external int flags;

  @Uint64()
  external int expectedByteLength;

  @Uint64()
  external int maximumPixelCount;
}

final class MobileStackRawDecodeResultNative extends Struct {
  @Uint32()
  external int abiVersion;

  @Uint32()
  external int structSize;

  @Int32()
  external int statusCode;

  @Int32()
  external int errorCode;

  @Uint32()
  external int format;

  @Uint32()
  external int width;

  @Uint32()
  external int height;

  @Uint32()
  external int activeLeft;

  @Uint32()
  external int activeTop;

  @Uint32()
  external int activeWidth;

  @Uint32()
  external int activeHeight;

  @Uint32()
  external int cfaPattern;

  @Uint32()
  external int orientation;

  @Float()
  external double blackLevel0;

  @Float()
  external double blackLevel1;

  @Float()
  external double blackLevel2;

  @Float()
  external double blackLevel3;

  @Float()
  external double whiteLevel;

  @Uint32()
  external int hasCameraWhiteBalance;

  @Float()
  external double cameraWhiteBalance0;

  @Float()
  external double cameraWhiteBalance1;

  @Float()
  external double cameraWhiteBalance2;

  @Float()
  external double cameraWhiteBalance3;

  external Pointer<Float> samples;

  @Uint64()
  external int sampleCount;

  @Uint32()
  external int rowStrideSamples;

  external Pointer<Uint8> errorMessage;

  @Uint32()
  external int errorMessageLength;
}

final class MobileStackRawMetadataProbeRequestNative extends Struct {
  @Uint32()
  external int abiVersion;

  @Uint32()
  external int structSize;

  @Uint32()
  external int expectedFormat;

  @Uint32()
  external int flags;

  @Uint64()
  external int expectedByteLength;
}

final class MobileStackRawMetadataProbeResultNative extends Struct {
  @Uint32()
  external int abiVersion;

  @Uint32()
  external int structSize;

  @Int32()
  external int statusCode;

  @Int32()
  external int errorCode;

  @Uint32()
  external int format;

  @Uint32()
  external int width;

  @Uint32()
  external int height;

  @Uint32()
  external int activeLeft;

  @Uint32()
  external int activeTop;

  @Uint32()
  external int activeWidth;

  @Uint32()
  external int activeHeight;

  @Uint32()
  external int cfaPattern;

  @Uint32()
  external int orientation;

  @Float()
  external double blackLevel0;

  @Float()
  external double blackLevel1;

  @Float()
  external double blackLevel2;

  @Float()
  external double blackLevel3;

  @Float()
  external double whiteLevel;

  @Uint32()
  external int hasCameraWhiteBalance;

  @Float()
  external double cameraWhiteBalance0;

  @Float()
  external double cameraWhiteBalance1;

  @Float()
  external double cameraWhiteBalance2;

  @Float()
  external double cameraWhiteBalance3;

  external Pointer<Uint8> errorMessage;

  @Uint32()
  external int errorMessageLength;

  @Uint32()
  external int hasD65XyzToCamera;

  @Array(9)
  external Array<Float> d65XyzToCamera;

  @Uint32()
  external int hasBaselineExposure;

  @Float()
  external double baselineExposure;

  external Pointer<Float> profileToneCurveXy;

  @Uint32()
  external int profileToneCurvePointCount;

  external Pointer<Float> profileHueSatMap;

  @Uint32()
  external int profileHueSatMapEntryCount;

  @Uint32()
  external int profileHueDivisions;

  @Uint32()
  external int profileSatDivisions;

  @Uint32()
  external int profileValDivisions;

  @Uint32()
  external int profileHueSatMapEncoding;

  external Pointer<Float> profileLookTable;

  @Uint32()
  external int profileLookTableEntryCount;

  @Uint32()
  external int profileLookHueDivisions;

  @Uint32()
  external int profileLookSatDivisions;

  @Uint32()
  external int profileLookValDivisions;

  @Uint32()
  external int profileLookTableEncoding;

  @Uint32()
  external int hasBaselineExposureOffset;

  @Float()
  external double baselineExposureOffset;

  @Uint32()
  external int hasProfileDynamicRange;

  @Uint32()
  external int profileDynamicRange;

  @Float()
  external double profileHintMaxOutputValue;

  external Pointer<Uint16> linearizationTable;

  @Uint32()
  external int linearizationTableCount;

  external Pointer<Float> blackLevelDeltaH;

  @Uint32()
  external int blackLevelDeltaHCount;

  external Pointer<Float> blackLevelDeltaV;

  @Uint32()
  external int blackLevelDeltaVCount;
}

typedef _AbiVersionNative = Uint32 Function();
typedef _AbiVersionDart = int Function();

typedef _CapabilitiesNative = Uint64 Function();
typedef _CapabilitiesDart = int Function();

typedef _CreateNative = Pointer<Void> Function();
typedef _CreateDart = Pointer<Void> Function();

typedef _DestroyNative = Void Function(Pointer<Void>);
typedef _DestroyDart = void Function(Pointer<Void>);

typedef _DecodeNative = Int32 Function(
  Pointer<Void>,
  Pointer<Uint8>,
  Uint32,
  Pointer<MobileStackRawDecodeRequestNative>,
  Pointer<Pointer<MobileStackRawDecodeResultNative>>,
);
typedef _DecodeDart = int Function(
  Pointer<Void>,
  Pointer<Uint8>,
  int,
  Pointer<MobileStackRawDecodeRequestNative>,
  Pointer<Pointer<MobileStackRawDecodeResultNative>>,
);

typedef _DecodeToFileNative = Int32 Function(
  Pointer<Void>,
  Pointer<Uint8>,
  Uint32,
  Pointer<Uint8>,
  Uint32,
  Pointer<MobileStackRawDecodeRequestNative>,
  Pointer<Pointer<MobileStackRawDecodeResultNative>>,
);
typedef _DecodeToFileDart = int Function(
  Pointer<Void>,
  Pointer<Uint8>,
  int,
  Pointer<Uint8>,
  int,
  Pointer<MobileStackRawDecodeRequestNative>,
  Pointer<Pointer<MobileStackRawDecodeResultNative>>,
);

typedef _TakeSamplesNative = Pointer<Float> Function(
  Pointer<MobileStackRawDecodeResultNative>,
);
typedef _TakeSamplesDart = Pointer<Float> Function(
  Pointer<MobileStackRawDecodeResultNative>,
);

typedef _ReleaseSamplesNative = Void Function(Pointer<Void>);
typedef _ReleaseSamplesDart = void Function(Pointer<Void>);

typedef _ReleaseResultNative = Void Function(
  Pointer<MobileStackRawDecodeResultNative>,
);
typedef _ReleaseResultDart = void Function(
  Pointer<MobileStackRawDecodeResultNative>,
);

typedef _ProbeMetadataNative = Int32 Function(
  Pointer<Void>,
  Pointer<Uint8>,
  Uint32,
  Pointer<MobileStackRawMetadataProbeRequestNative>,
  Pointer<Pointer<MobileStackRawMetadataProbeResultNative>>,
);
typedef _ProbeMetadataDart = int Function(
  Pointer<Void>,
  Pointer<Uint8>,
  int,
  Pointer<MobileStackRawMetadataProbeRequestNative>,
  Pointer<Pointer<MobileStackRawMetadataProbeResultNative>>,
);

typedef _ReleaseMetadataResultNative = Void Function(
  Pointer<MobileStackRawMetadataProbeResultNative>,
);
typedef _ReleaseMetadataResultDart = void Function(
  Pointer<MobileStackRawMetadataProbeResultNative>,
);

class _FfiRawNativeBindings {
  _FfiRawNativeBindings(DynamicLibrary library)
      : abiVersion = library.lookupFunction<_AbiVersionNative, _AbiVersionDart>(
            'mobile_stack_raw_abi_version'),
        capabilities = library.providesSymbol(
          'mobile_stack_raw_capabilities',
        )
            ? library.lookupFunction<_CapabilitiesNative, _CapabilitiesDart>(
                'mobile_stack_raw_capabilities')
            : null,
        create = library.lookupFunction<_CreateNative, _CreateDart>(
            'mobile_stack_raw_decoder_create'),
        destroy = library.lookupFunction<_DestroyNative, _DestroyDart>(
            'mobile_stack_raw_decoder_destroy'),
        decode = library.lookupFunction<_DecodeNative, _DecodeDart>(
            'mobile_stack_raw_decode'),
        decodeToFile = library.providesSymbol('mobile_stack_raw_decode_to_file')
            ? library.lookupFunction<_DecodeToFileNative, _DecodeToFileDart>(
                'mobile_stack_raw_decode_to_file')
            : null,
        takeSamples =
            library.lookupFunction<_TakeSamplesNative, _TakeSamplesDart>(
                'mobile_stack_raw_decode_result_take_samples'),
        samplesFinalizer =
            library.lookup<NativeFunction<Void Function(Pointer<Void>)>>(
                'mobile_stack_raw_samples_release'),
        releaseSamples =
            library.lookupFunction<_ReleaseSamplesNative, _ReleaseSamplesDart>(
                'mobile_stack_raw_samples_release'),
        releaseResult =
            library.lookupFunction<_ReleaseResultNative, _ReleaseResultDart>(
                'mobile_stack_raw_decode_result_release'),
        probeMetadata = library.providesSymbol(
          'mobile_stack_raw_probe_metadata',
        )
            ? library.lookupFunction<_ProbeMetadataNative, _ProbeMetadataDart>(
                'mobile_stack_raw_probe_metadata')
            : null,
        releaseMetadataResult = library.providesSymbol(
          'mobile_stack_raw_metadata_result_release',
        )
            ? library.lookupFunction<_ReleaseMetadataResultNative,
                _ReleaseMetadataResultDart>(
                'mobile_stack_raw_metadata_result_release',
              )
            : null;

  final _AbiVersionDart abiVersion;
  final _CapabilitiesDart? capabilities;
  final _CreateDart create;
  final _DestroyDart destroy;
  final _DecodeDart decode;
  final _DecodeToFileDart? decodeToFile;
  final _TakeSamplesDart takeSamples;
  final Pointer<NativeFinalizerFunction> samplesFinalizer;
  final _ReleaseSamplesDart releaseSamples;
  final _ReleaseResultDart releaseResult;
  final _ProbeMetadataDart? probeMetadata;
  final _ReleaseMetadataResultDart? releaseMetadataResult;
}

/// 1回のワーカー処理内だけで使用する同期FFIブリッジ。
///
/// 成功時のサンプル配列はNative結果から所有権を切り離し、外部
/// Float32ListとしてDartへ渡す。GC時にはNative finalizerが同じ領域を
/// 解放するため、Native→Dartのフルフレーム複製を作らない。

final class _FfiRawSampleLease implements RawSampleLease, Finalizable {
  _FfiRawSampleLease({
    required Pointer<Float> pointer,
    required Float32List samples,
    required Pointer<NativeFinalizerFunction> finalizerPointer,
    required _ReleaseSamplesDart releaseSamples,
  })  : _pointer = pointer,
        _releaseSamples = releaseSamples,
        _finalizer = NativeFinalizer(finalizerPointer) {
    _finalizer.attach(
      this,
      pointer.cast<Void>(),
      detach: _detachToken,
      externalSize: samples.lengthInBytes,
    );
  }

  final Pointer<Float> _pointer;
  final _ReleaseSamplesDart _releaseSamples;
  final NativeFinalizer _finalizer;
  final Object _detachToken = Object();
  bool _released = false;

  @override
  bool get isReleased => _released;

  @override
  void release() {
    if (_released) return;
    _finalizer.detach(_detachToken);
    _releaseSamples(_pointer.cast<Void>());
    _released = true;
  }
}

class FfiRawNativeBridge {
  FfiRawNativeBridge._({
    required _FfiRawNativeBindings bindings,
    required Pointer<Void> context,
  })  : _bindings = bindings,
        _context = context;

  factory FfiRawNativeBridge.openForCurrentPlatform({
    String androidLibraryName = rawNativeLibraryName,
  }) {
    try {
      final DynamicLibrary library =
          switch ((Platform.isAndroid, Platform.isIOS)) {
        (true, _) => DynamicLibrary.open(androidLibraryName),
        (_, true) => DynamicLibrary.process(),
        _ => throw const RawDecoderUnavailable(
            'Native RAWデコーダーはAndroid/iOSでのみ利用できます。',
          ),
      };
      final _FfiRawNativeBindings bindings = _FfiRawNativeBindings(library);
      final int abiVersion = bindings.abiVersion();
      if (abiVersion != rawNativeAbiVersion) {
        throw RawDecodeFailure(
          code: RawDecodeErrorCode.abiMismatch,
          message: 'Native RAW ABIが一致しません。'
              ' expected=$rawNativeAbiVersion actual=$abiVersion',
        );
      }
      final Pointer<Void> context = bindings.create();
      if (context == nullptr) {
        throw const RawDecodeFailure(
          code: RawDecodeErrorCode.nativeFailure,
          message: 'Native RAWデコーダーを初期化できません。',
        );
      }
      return FfiRawNativeBridge._(
        bindings: bindings,
        context: context,
      );
    } on RawDecoderUnavailable {
      rethrow;
    } on RawDecodeFailure {
      rethrow;
    } on ArgumentError catch (error) {
      throw RawDecoderUnavailable(
        'Native RAWライブラリまたは必須シンボルを読み込めません: $error',
      );
    }
  }

  final _FfiRawNativeBindings _bindings;
  Pointer<Void> _context;

  bool get isClosed => _context == nullptr;

  int get capabilities =>
      _bindings.capabilities?.call() ?? rawNativeCapabilityDecode;

  bool get supportsMetadataProbe =>
      (capabilities & rawNativeCapabilityMetadataProbe) != 0 &&
      _bindings.probeMetadata != null &&
      _bindings.releaseMetadataResult != null;

  bool get supportsProductionDngMetadata =>
      supportsMetadataProbe &&
      (capabilities & rawNativeCapabilityDngMetadata) != 0;

  bool get supportsProductionArwLossless =>
      (capabilities &
          (rawNativeCapabilityArwLosslessJpeg | rawNativeCapabilitySonyArw2)) !=
      0;

  bool get supportsSonyArw2 =>
      (capabilities & rawNativeCapabilitySonyArw2) != 0;

  bool get supportsBroadSonyRaw =>
      (capabilities & rawNativeCapabilityLibRawSony) != 0;

  bool get supportsBroadNikonRaw =>
      (capabilities & rawNativeCapabilityLibRawNikon) != 0;

  RawNativeDecodedFrame decode(
    RawNativeDecodeCommand command, {
    bool takeSampleOwnership = false,
  }) {
    if (isClosed) {
      throw StateError('Native RAWデコーダーは破棄済みです。');
    }
    if (command.path.isEmpty || command.path.contains('\u0000')) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: 'RAWファイルパスが不正です。',
      );
    }
    if (command.expectedFormat == RawFormat.unknown ||
        command.expectedByteLength < 0 ||
        command.maximumPixelCount <= 0) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: 'Native RAWデコード要求が不正です。',
      );
    }

    final int pathByteLength = utf8.encode(command.path).length;
    if (pathByteLength > 0xFFFFFFFF) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: 'RAWファイルパスが長すぎます。',
      );
    }

    return using((Arena arena) {
      final Pointer<Utf8> path = command.path.toNativeUtf8(allocator: arena);
      final Pointer<MobileStackRawDecodeRequestNative> request =
          arena<MobileStackRawDecodeRequestNative>();
      request.ref
        ..abiVersion = rawNativeAbiVersion
        ..structSize = sizeOf<MobileStackRawDecodeRequestNative>()
        ..expectedFormat = rawFormatToNativeCode(command.expectedFormat)
        ..outputPrecision = precisionToNativeCode(command.outputPrecision)
        ..flags = 1
        ..expectedByteLength = command.expectedByteLength
        ..maximumPixelCount = command.maximumPixelCount;

      final Pointer<Pointer<MobileStackRawDecodeResultNative>> resultOut =
          arena<Pointer<MobileStackRawDecodeResultNative>>();
      resultOut.value = nullptr;

      final int callStatus = _bindings.decode(
        _context,
        path.cast<Uint8>(),
        pathByteLength,
        request,
        resultOut,
      );
      final Pointer<MobileStackRawDecodeResultNative> result = resultOut.value;
      if (result == nullptr) {
        final RawNativeStatus status = RawNativeStatus.fromCode(callStatus);
        throw RawDecodeFailure(
          code: status.toDecodeErrorCode(),
          message: 'Native RAWデコーダーが結果を返しませんでした。',
          nativeCode: callStatus,
        );
      }

      try {
        return _copyResult(
          result,
          callStatus,
          command,
          takeSampleOwnership: takeSampleOwnership,
        );
      } finally {
        _bindings.releaseResult(result);
      }
    });
  }

  bool get supportsDecodeToFile => _bindings.decodeToFile != null;

  RawNativeFileDecodedFrame decodeToFile(
    RawNativeDecodeCommand command, {
    required String outputPath,
  }) {
    if (isClosed) {
      throw StateError('Native RAWデコーダーは破棄済みです。');
    }
    final _DecodeToFileDart? decodeFunction = _bindings.decodeToFile;
    if (decodeFunction == null) {
      throw const RawDecoderUnavailable(
        'Native RAWライブラリはストリームデコードに対応していません。',
      );
    }
    if (command.path.isEmpty ||
        command.path.contains('\u0000') ||
        outputPath.isEmpty ||
        outputPath.contains('\u0000')) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: 'RAWまたは出力ファイルパスが不正です。',
      );
    }
    if (command.expectedFormat == RawFormat.unknown ||
        command.expectedByteLength < 0 ||
        command.maximumPixelCount <= 0) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: 'Native RAWストリームデコード要求が不正です。',
      );
    }

    final int pathByteLength = utf8.encode(command.path).length;
    final int outputPathByteLength = utf8.encode(outputPath).length;
    if (pathByteLength > 0xFFFFFFFF || outputPathByteLength > 0xFFFFFFFF) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: 'RAWまたは出力ファイルパスが長すぎます。',
      );
    }

    return using((Arena arena) {
      final Pointer<Utf8> path = command.path.toNativeUtf8(allocator: arena);
      final Pointer<Utf8> output = outputPath.toNativeUtf8(allocator: arena);
      final Pointer<MobileStackRawDecodeRequestNative> request =
          arena<MobileStackRawDecodeRequestNative>();
      request.ref
        ..abiVersion = rawNativeAbiVersion
        ..structSize = sizeOf<MobileStackRawDecodeRequestNative>()
        ..expectedFormat = rawFormatToNativeCode(command.expectedFormat)
        ..outputPrecision = precisionToNativeCode(command.outputPrecision)
        ..flags = 1
        ..expectedByteLength = command.expectedByteLength
        ..maximumPixelCount = command.maximumPixelCount;

      final Pointer<Pointer<MobileStackRawDecodeResultNative>> resultOut =
          arena<Pointer<MobileStackRawDecodeResultNative>>();
      resultOut.value = nullptr;

      final int callStatus = decodeFunction(
        _context,
        path.cast<Uint8>(),
        pathByteLength,
        output.cast<Uint8>(),
        outputPathByteLength,
        request,
        resultOut,
      );
      final Pointer<MobileStackRawDecodeResultNative> result = resultOut.value;
      if (result == nullptr) {
        final RawNativeStatus status = RawNativeStatus.fromCode(callStatus);
        throw RawDecodeFailure(
          code: status.toDecodeErrorCode(),
          message: 'Native RAWストリームデコーダーが結果を返しませんでした。',
          nativeCode: callStatus,
        );
      }

      try {
        final MobileStackRawDecodeResultNative native = result.ref;
        if (native.abiVersion != rawNativeAbiVersion ||
            native.structSize < sizeOf<MobileStackRawDecodeResultNative>()) {
          throw RawDecodeFailure(
            code: RawDecodeErrorCode.abiMismatch,
            message: 'Native RAWストリーム結果のABI構造が一致しません。',
            nativeCode: native.errorCode,
          );
        }
        final int effectiveStatus = callStatus == RawNativeStatus.ok.code
            ? native.statusCode
            : callStatus;
        if (effectiveStatus != RawNativeStatus.ok.code) {
          final RawNativeStatus status =
              RawNativeStatus.fromCode(effectiveStatus);
          final String nativeMessage = _copyErrorBytes(
            native.errorMessage,
            native.errorMessageLength,
          );
          throw RawDecodeFailure(
            code: status.toDecodeErrorCode(),
            message: nativeMessage.isEmpty
                ? 'Native RAWストリームデコードに失敗しました。'
                : nativeMessage,
            nativeCode: native.errorCode,
          );
        }

        final RawFormat format = rawFormatFromNativeCode(native.format);
        final CfaPattern? cfaPattern =
            cfaPatternFromNativeCode(native.cfaPattern);
        final int pixelCount = native.width * native.height;
        if (format == RawFormat.unknown ||
            cfaPattern == null ||
            native.width <= 0 ||
            native.height <= 0 ||
            pixelCount > command.maximumPixelCount ||
            native.sampleCount != pixelCount ||
            native.rowStrideSamples != native.width ||
            native.samples != nullptr) {
          throw RawDecodeFailure(
            code: RawDecodeErrorCode.corruptData,
            message: 'Native RAWストリーム結果の寸法または所有権情報が不正です。',
            nativeCode: native.errorCode,
          );
        }

        final List<double>? cameraWhiteBalance =
            native.hasCameraWhiteBalance == 0
                ? null
                : <double>[
                    native.cameraWhiteBalance0,
                    native.cameraWhiteBalance1,
                    native.cameraWhiteBalance2,
                    native.cameraWhiteBalance3,
                  ];
        return RawNativeFileDecodedFrame(
          format: format,
          width: native.width,
          height: native.height,
          cfaPattern: cfaPattern,
          activeArea: RawActiveArea(
            left: native.activeLeft,
            top: native.activeTop,
            width: native.activeWidth,
            height: native.activeHeight,
          ),
          orientation: native.orientation,
          blackLevels: <double>[
            native.blackLevel0,
            native.blackLevel1,
            native.blackLevel2,
            native.blackLevel3,
          ],
          whiteLevel: native.whiteLevel,
          cameraWhiteBalance: cameraWhiteBalance,
          samplePath: outputPath,
        );
      } finally {
        _bindings.releaseResult(result);
      }
    });
  }

  RawNativeMetadataFrame probeMetadata(
    RawNativeMetadataProbeCommand command,
  ) {
    if (isClosed) {
      throw StateError('Native RAWデコーダーは破棄済みです。');
    }
    final _ProbeMetadataDart? probeFunction = _bindings.probeMetadata;
    final _ReleaseMetadataResultDart? releaseFunction =
        _bindings.releaseMetadataResult;
    if (!supportsMetadataProbe ||
        probeFunction == null ||
        releaseFunction == null) {
      throw const RawDecoderUnavailable(
        'Native RAWライブラリはメタデータ検査拡張に対応していません。',
      );
    }
    if (command.path.isEmpty || command.path.contains('\u0000')) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: 'RAWファイルパスが不正です。',
      );
    }
    if (command.expectedFormat == RawFormat.unknown ||
        command.expectedByteLength < 0) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: 'Native RAWメタデータ要求が不正です。',
      );
    }

    final int pathByteLength = utf8.encode(command.path).length;
    if (pathByteLength > 0xFFFFFFFF) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: 'RAWファイルパスが長すぎます。',
      );
    }

    return using((Arena arena) {
      final Pointer<Utf8> path = command.path.toNativeUtf8(allocator: arena);
      final Pointer<MobileStackRawMetadataProbeRequestNative> request =
          arena<MobileStackRawMetadataProbeRequestNative>();
      request.ref
        ..abiVersion = rawNativeAbiVersion
        ..structSize = sizeOf<MobileStackRawMetadataProbeRequestNative>()
        ..expectedFormat = rawFormatToNativeCode(command.expectedFormat)
        ..flags = 0
        ..expectedByteLength = command.expectedByteLength;

      final Pointer<Pointer<MobileStackRawMetadataProbeResultNative>>
          resultOut = arena<Pointer<MobileStackRawMetadataProbeResultNative>>();
      resultOut.value = nullptr;

      final int callStatus = probeFunction(
        _context,
        path.cast<Uint8>(),
        pathByteLength,
        request,
        resultOut,
      );
      final Pointer<MobileStackRawMetadataProbeResultNative> result =
          resultOut.value;
      if (result == nullptr) {
        final RawNativeStatus status = RawNativeStatus.fromCode(callStatus);
        throw RawDecodeFailure(
          code: status.toDecodeErrorCode(),
          message: 'Native RAWメタデータ検査が結果を返しませんでした。',
          nativeCode: callStatus,
        );
      }

      try {
        return _copyMetadataResult(result, callStatus);
      } finally {
        releaseFunction(result);
      }
    });
  }

  RawNativeDecodedFrame _copyResult(
    Pointer<MobileStackRawDecodeResultNative> resultPointer,
    int callStatus,
    RawNativeDecodeCommand command, {
    required bool takeSampleOwnership,
  }) {
    final MobileStackRawDecodeResultNative result = resultPointer.ref;
    if (result.abiVersion != rawNativeAbiVersion ||
        result.structSize < sizeOf<MobileStackRawDecodeResultNative>()) {
      throw RawDecodeFailure(
        code: RawDecodeErrorCode.abiMismatch,
        message: 'Native RAW結果のABI構造が一致しません。',
        nativeCode: result.errorCode,
      );
    }

    final int effectiveStatus =
        callStatus == RawNativeStatus.ok.code ? result.statusCode : callStatus;
    if (effectiveStatus != RawNativeStatus.ok.code) {
      final RawNativeStatus status = RawNativeStatus.fromCode(effectiveStatus);
      final String nativeMessage = _copyErrorBytes(
        result.errorMessage,
        result.errorMessageLength,
      );
      throw RawDecodeFailure(
        code: status.toDecodeErrorCode(),
        message:
            nativeMessage.isEmpty ? 'Native RAWデコードに失敗しました。' : nativeMessage,
        nativeCode: result.errorCode,
      );
    }

    final RawFormat format = rawFormatFromNativeCode(result.format);
    final CfaPattern? cfaPattern = cfaPatternFromNativeCode(result.cfaPattern);
    final int pixelCount = result.width * result.height;
    if (format == RawFormat.unknown ||
        cfaPattern == null ||
        result.width <= 0 ||
        result.height <= 0 ||
        pixelCount > command.maximumPixelCount ||
        result.sampleCount != pixelCount ||
        result.rowStrideSamples != result.width ||
        result.samples == nullptr) {
      throw RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'Native RAW結果の寸法またはバッファ情報が不正です。',
        nativeCode: result.errorCode,
      );
    }

    final Float32List nativeSamples;
    RawSampleLease? sampleLease;
    if (takeSampleOwnership) {
      // Background workers already run in a headless worker isolate. In that
      // path there is no reason to create yet another isolate just for FFI, so
      // the native FP32 allocation can become the Dart Float32List directly.
      // The result object relinquishes ownership before its enclosing `finally`
      // runs, and the list frees the allocation through a native finalizer.
      final Pointer<Float> ownedSamples = _bindings.takeSamples(resultPointer);
      if (ownedSamples == nullptr || resultPointer.ref.samples != nullptr) {
        throw RawDecodeFailure(
          code: RawDecodeErrorCode.corruptData,
          message: 'Native RAWサンプルの所有権移譲に失敗しました。',
          nativeCode: result.errorCode,
        );
      }
      nativeSamples = ownedSamples.asTypedList(result.sampleCount);
      sampleLease = _FfiRawSampleLease(
        pointer: ownedSamples,
        samples: nativeSamples,
        finalizerPointer: _bindings.samplesFinalizer,
        releaseSamples: _bindings.releaseSamples,
      );
    } else {
      // The generic backend returns through Isolate.run(). Keep an owned Dart
      // copy there so the returned object remains a normal isolate-sendable
      // object and never exposes native lifetime across an isolate boundary.
      nativeSamples = Float32List.fromList(
        result.samples.asTypedList(result.sampleCount),
      );
    }
    final List<double>? cameraWhiteBalance = result.hasCameraWhiteBalance == 0
        ? null
        : <double>[
            result.cameraWhiteBalance0,
            result.cameraWhiteBalance1,
            result.cameraWhiteBalance2,
            result.cameraWhiteBalance3,
          ];

    return RawNativeDecodedFrame.takeOwnedSamples(
      format: format,
      width: result.width,
      height: result.height,
      cfaPattern: cfaPattern,
      activeArea: RawActiveArea(
        left: result.activeLeft,
        top: result.activeTop,
        width: result.activeWidth,
        height: result.activeHeight,
      ),
      orientation: result.orientation,
      blackLevels: <double>[
        result.blackLevel0,
        result.blackLevel1,
        result.blackLevel2,
        result.blackLevel3,
      ],
      whiteLevel: result.whiteLevel,
      cameraWhiteBalance: cameraWhiteBalance,
      samples: nativeSamples,
      sampleLease: sampleLease,
    );
  }

  RawNativeMetadataFrame _copyMetadataResult(
    Pointer<MobileStackRawMetadataProbeResultNative> resultPointer,
    int callStatus,
  ) {
    final MobileStackRawMetadataProbeResultNative result = resultPointer.ref;
    final int legacyMinimumSize = sizeOf<IntPtr>() == 8 ? 112 : 100;
    if (result.abiVersion != rawNativeAbiVersion ||
        result.structSize < legacyMinimumSize) {
      throw RawDecodeFailure(
        code: RawDecodeErrorCode.abiMismatch,
        message: 'Native RAWメタデータ結果のABI構造が一致しません。',
        nativeCode: result.errorCode,
      );
    }

    final int effectiveStatus =
        callStatus == RawNativeStatus.ok.code ? result.statusCode : callStatus;
    if (effectiveStatus != RawNativeStatus.ok.code) {
      final RawNativeStatus status = RawNativeStatus.fromCode(effectiveStatus);
      final String nativeMessage = _copyErrorBytes(
        result.errorMessage,
        result.errorMessageLength,
      );
      throw RawDecodeFailure(
        code: status.toDecodeErrorCode(),
        message:
            nativeMessage.isEmpty ? 'Native RAWメタデータ検査に失敗しました。' : nativeMessage,
        nativeCode: result.errorCode,
      );
    }

    final RawFormat format = rawFormatFromNativeCode(result.format);
    final CfaPattern? cfaPattern = cfaPatternFromNativeCode(result.cfaPattern);
    if (format == RawFormat.unknown ||
        cfaPattern == null ||
        result.width <= 0 ||
        result.height <= 0) {
      throw RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'Native RAWメタデータの形式または寸法が不正です。',
        nativeCode: result.errorCode,
      );
    }

    final List<double>? cameraWhiteBalance = result.hasCameraWhiteBalance == 0
        ? null
        : <double>[
            result.cameraWhiteBalance0,
            result.cameraWhiteBalance1,
            result.cameraWhiteBalance2,
            result.cameraWhiteBalance3,
          ];
    final bool is64Bit = sizeOf<IntPtr>() == 8;
    final int colorTailStructSize = is64Bit ? 152 : 140;
    final int baselineExposureTailStructSize = is64Bit ? 160 : 148;
    final int profileToneCurveTailStructSize = is64Bit ? 176 : 156;
    final int profileHueSatMapTailStructSize = is64Bit ? 208 : 180;
    final int profileLookTableTailStructSize = is64Bit ? 240 : 204;
    final int baselineExposureOffsetTailStructSize = is64Bit ? 248 : 212;
    final int profileDynamicRangeTailStructSize = is64Bit ? 256 : 224;
    final int rawLinearizationTailStructSize = is64Bit ? 304 : 248;
    final bool hasColorTail = result.structSize >= colorTailStructSize;
    final List<double>? d65XyzToCamera =
        !hasColorTail || result.hasD65XyzToCamera == 0
            ? null
            : <double>[
                for (int index = 0; index < 9; index++)
                  result.d65XyzToCamera[index],
              ];
    final double? baselineExposure =
        result.structSize < baselineExposureTailStructSize ||
                result.hasBaselineExposure == 0
            ? null
            : result.baselineExposure;
    List<double>? profileToneCurve;
    if (result.structSize >= profileToneCurveTailStructSize) {
      final int pointCount = result.profileToneCurvePointCount;
      if (pointCount != 0) {
        if (pointCount < 2 ||
            pointCount > 8192 ||
            result.profileToneCurveXy == nullptr) {
          throw RawDecodeFailure(
            code: RawDecodeErrorCode.corruptData,
            message: 'Native DNG profile tone curve is invalid.',
            nativeCode: result.errorCode,
          );
        }
        profileToneCurve = List<double>.unmodifiable(
          result.profileToneCurveXy.asTypedList(pointCount * 2),
        );
      } else if (result.profileToneCurveXy != nullptr) {
        throw RawDecodeFailure(
          code: RawDecodeErrorCode.corruptData,
          message: 'Native DNG profile tone curve ownership is invalid.',
          nativeCode: result.errorCode,
        );
      }
    }
    RawProfileHueSatMap? profileHueSatMap;
    if (result.structSize >= profileHueSatMapTailStructSize) {
      final int entryCount = result.profileHueSatMapEntryCount;
      if (entryCount != 0) {
        final int hues = result.profileHueDivisions;
        final int sats = result.profileSatDivisions;
        final int vals = result.profileValDivisions;
        if (hues < 1 ||
            hues > 360 ||
            sats < 2 ||
            sats > 256 ||
            vals < 1 ||
            vals > 64 ||
            entryCount > 262144 ||
            hues * sats * vals != entryCount ||
            result.profileHueSatMap == nullptr ||
            result.profileHueSatMapEncoding > 1) {
          throw RawDecodeFailure(
            code: RawDecodeErrorCode.corruptData,
            message: 'Native DNG profile hue/saturation map is invalid.',
            nativeCode: result.errorCode,
          );
        }
        profileHueSatMap = RawProfileHueSatMap(
          hueDivisions: hues,
          saturationDivisions: sats,
          valueDivisions: vals,
          encoding: result.profileHueSatMapEncoding,
          deltas: result.profileHueSatMap.asTypedList(entryCount * 3),
        );
      } else if (result.profileHueSatMap != nullptr) {
        throw RawDecodeFailure(
          code: RawDecodeErrorCode.corruptData,
          message:
              'Native DNG profile hue/saturation map ownership is invalid.',
          nativeCode: result.errorCode,
        );
      }
    }
    RawProfileLookTable? profileLookTable;
    if (result.structSize >= profileLookTableTailStructSize) {
      final int entryCount = result.profileLookTableEntryCount;
      if (entryCount != 0) {
        final int hues = result.profileLookHueDivisions;
        final int sats = result.profileLookSatDivisions;
        final int vals = result.profileLookValDivisions;
        if (hues < 1 ||
            hues > 360 ||
            sats < 2 ||
            sats > 256 ||
            vals < 1 ||
            vals > 64 ||
            entryCount > 262144 ||
            hues * sats * vals != entryCount ||
            result.profileLookTable == nullptr ||
            result.profileLookTableEncoding > 1) {
          throw RawDecodeFailure(
            code: RawDecodeErrorCode.corruptData,
            message: 'Native DNG profile look table is invalid.',
            nativeCode: result.errorCode,
          );
        }
        profileLookTable = RawProfileLookTable(
          hueDivisions: hues,
          saturationDivisions: sats,
          valueDivisions: vals,
          encoding: result.profileLookTableEncoding,
          deltas: result.profileLookTable.asTypedList(entryCount * 3),
        );
      } else if (result.profileLookTable != nullptr) {
        throw RawDecodeFailure(
          code: RawDecodeErrorCode.corruptData,
          message: 'Native DNG profile look table ownership is invalid.',
          nativeCode: result.errorCode,
        );
      }
    }
    final double? baselineExposureOffset =
        result.structSize < baselineExposureOffsetTailStructSize ||
                result.hasBaselineExposureOffset == 0
            ? null
            : result.baselineExposureOffset;
    int? profileDynamicRange;
    double? profileHintMaxOutputValue;
    if (result.structSize >= profileDynamicRangeTailStructSize &&
        result.hasProfileDynamicRange != 0) {
      final int dynamicRange = result.profileDynamicRange;
      final double hint = result.profileHintMaxOutputValue;
      if ((dynamicRange != 0 && dynamicRange != 1) ||
          !hint.isFinite ||
          (dynamicRange == 0 && hint > 1)) {
        throw RawDecodeFailure(
          code: RawDecodeErrorCode.corruptData,
          message: 'Native DNG ProfileDynamicRange is invalid.',
          nativeCode: result.errorCode,
        );
      }
      profileDynamicRange = dynamicRange;
      profileHintMaxOutputValue = hint;
    }
    List<double>? linearizationTable;
    List<double>? blackLevelDeltaH;
    List<double>? blackLevelDeltaV;
    if (result.structSize >= rawLinearizationTailStructSize) {
      final int linearizationCount = result.linearizationTableCount;
      if (linearizationCount != 0) {
        if (linearizationCount > 65536 ||
            result.linearizationTable == nullptr) {
          throw RawDecodeFailure(
            code: RawDecodeErrorCode.corruptData,
            message: 'Native DNG linearization table is invalid.',
            nativeCode: result.errorCode,
          );
        }
        linearizationTable = <double>[
          for (final int value
              in result.linearizationTable.asTypedList(linearizationCount))
            value.toDouble(),
        ];
      } else if (result.linearizationTable != nullptr) {
        throw RawDecodeFailure(
          code: RawDecodeErrorCode.corruptData,
          message: 'Native DNG linearization table ownership is invalid.',
          nativeCode: result.errorCode,
        );
      }
      final int hCount = result.blackLevelDeltaHCount;
      if (hCount != 0) {
        if (hCount != result.activeWidth ||
            result.blackLevelDeltaH == nullptr) {
          throw RawDecodeFailure(
            code: RawDecodeErrorCode.corruptData,
            message: 'Native DNG horizontal black-level delta is invalid.',
            nativeCode: result.errorCode,
          );
        }
        blackLevelDeltaH = List<double>.from(
          result.blackLevelDeltaH.asTypedList(hCount),
          growable: false,
        );
      } else if (result.blackLevelDeltaH != nullptr) {
        throw RawDecodeFailure(
          code: RawDecodeErrorCode.corruptData,
          message:
              'Native DNG horizontal black-level delta ownership is invalid.',
          nativeCode: result.errorCode,
        );
      }
      final int vCount = result.blackLevelDeltaVCount;
      if (vCount != 0) {
        if (vCount != result.activeHeight ||
            result.blackLevelDeltaV == nullptr) {
          throw RawDecodeFailure(
            code: RawDecodeErrorCode.corruptData,
            message: 'Native DNG vertical black-level delta is invalid.',
            nativeCode: result.errorCode,
          );
        }
        blackLevelDeltaV = List<double>.from(
          result.blackLevelDeltaV.asTypedList(vCount),
          growable: false,
        );
      } else if (result.blackLevelDeltaV != nullptr) {
        throw RawDecodeFailure(
          code: RawDecodeErrorCode.corruptData,
          message:
              'Native DNG vertical black-level delta ownership is invalid.',
          nativeCode: result.errorCode,
        );
      }
    }
    return RawNativeMetadataFrame(
      format: format,
      width: result.width,
      height: result.height,
      cfaPattern: cfaPattern,
      activeArea: RawActiveArea(
        left: result.activeLeft,
        top: result.activeTop,
        width: result.activeWidth,
        height: result.activeHeight,
      ),
      orientation: result.orientation,
      blackLevels: <double>[
        result.blackLevel0,
        result.blackLevel1,
        result.blackLevel2,
        result.blackLevel3,
      ],
      whiteLevel: result.whiteLevel,
      cameraWhiteBalance: cameraWhiteBalance,
      d65XyzToCamera: d65XyzToCamera,
      baselineExposure: baselineExposure,
      baselineExposureOffset: baselineExposureOffset,
      profileDynamicRange: profileDynamicRange,
      profileHintMaxOutputValue: profileHintMaxOutputValue,
      profileToneCurve: profileToneCurve,
      profileHueSatMap: profileHueSatMap,
      profileLookTable: profileLookTable,
      linearizationTable: linearizationTable,
      blackLevelDeltaH: blackLevelDeltaH,
      blackLevelDeltaV: blackLevelDeltaV,
    );
  }

  String _copyErrorBytes(Pointer<Uint8> pointer, int byteLength) {
    if (pointer == nullptr || byteLength == 0) {
      return '';
    }
    const int maximumErrorBytes = 4096;
    final int length =
        byteLength > maximumErrorBytes ? maximumErrorBytes : byteLength;
    final Uint8List messageBytes = Uint8List.fromList(
      pointer.asTypedList(length),
    );
    return utf8.decode(messageBytes, allowMalformed: true);
  }

  void close() {
    if (isClosed) return;
    final Pointer<Void> context = _context;
    _context = nullptr;
    _bindings.destroy(context);
  }
}

/// 同期FFI呼び出しをワーカーIsolateへ隔離する実運用バックエンド。
class FfiRawDecodeWorker implements RawNativeDecodeBackend {
  const FfiRawDecodeWorker({
    this.androidLibraryName = rawNativeLibraryName,
  });

  final String androidLibraryName;

  @override
  Future<RawNativeDecodedFrame> decode(
    RawNativeDecodeCommand command,
  ) {
    final String libraryName = androidLibraryName;
    return traceNativeOperation(
        operation: 'rawDecode',
        stage: command.path,
        call: () => Isolate.run(() {
              lowerCurrentThreadPriorityForBackgroundWork();
              final FfiRawNativeBridge bridge =
                  FfiRawNativeBridge.openForCurrentPlatform(
                androidLibraryName: libraryName,
              );
              try {
                return bridge.decode(command);
              } finally {
                bridge.close();
              }
            }));
  }
}

/// RAW decoding backend for callers that are already executing inside a
/// dedicated background/headless isolate. It avoids the redundant nested
/// Isolate.run() and adopts the native FP32 sensor buffer instead of copying a
/// second full-resolution plane. Do not use this backend from the UI isolate.
class FfiRawDecodeCurrentIsolateBackend
    implements RawNativeDecodeBackend, RawNativeFileDecodeBackend {
  const FfiRawDecodeCurrentIsolateBackend({
    this.androidLibraryName = rawNativeLibraryName,
  });

  final String androidLibraryName;

  @override
  Future<RawNativeDecodedFrame> decode(
    RawNativeDecodeCommand command,
  ) async {
    final FfiRawNativeBridge bridge = FfiRawNativeBridge.openForCurrentPlatform(
      androidLibraryName: androidLibraryName,
    );
    try {
      return bridge.decode(command, takeSampleOwnership: true);
    } finally {
      bridge.close();
    }
  }

  @override
  Future<RawNativeFileDecodedFrame> decodeToFile({
    required RawNativeDecodeCommand command,
    required String outputPath,
  }) async {
    final FfiRawNativeBridge bridge =
        FfiRawNativeBridge.openForCurrentPlatform();
    try {
      return bridge.decodeToFile(command, outputPath: outputPath);
    } finally {
      bridge.close();
    }
  }
}

/// Background/headless variant of [FfiRawDecodeWorker] that also implements
/// [RawNativeFileDecodeBackend], for callers (background stack workers) that
/// need the streamed/file-backed decode path's low memory footprint but must
/// not let the synchronous FFI call block their own isolate's event loop.
///
/// [FfiRawDecodeCurrentIsolateBackend] intentionally runs on the caller's
/// isolate to avoid a redundant isolate hop and an extra full-frame buffer
/// copy — a fine trade when the caller isolate has nothing else it needs to
/// keep servicing. Background stack workers do not fit that description:
/// their own `JobScheduler` runs a per-frame stall watchdog as a plain Dart
/// `Timer` on that same isolate (see `fullFrameRawStallTimeout`), and a
/// `Timer` cannot fire while a synchronous call is holding the isolate's
/// event loop hostage. A hung or merely extremely slow native decode then
/// silently disables the very safety net meant to catch it, surfacing as a
/// full app freeze (ANR) instead of the intended timeout failure.
///
/// [decodeToFile] pays no extra copy for this isolation: the native call
/// already writes samples straight to disk, so only a small metadata record
/// and a file path cross the isolate boundary. [decode] (the in-memory
/// fallback path) does pay one extra full-frame `Float32List` copy, same as
/// [FfiRawDecodeWorker] — an acceptable cost given it is already the slower
/// fallback path, and non-optional given the alternative is an app-level
/// freeze.
class FfiRawDecodeBackgroundWorkerBackend
    implements RawNativeDecodeBackend, RawNativeFileDecodeBackend {
  const FfiRawDecodeBackgroundWorkerBackend({
    this.androidLibraryName = rawNativeLibraryName,
  });

  final String androidLibraryName;

  @override
  Future<RawNativeDecodedFrame> decode(
    RawNativeDecodeCommand command,
  ) {
    final String libraryName = androidLibraryName;
    return traceNativeOperation(
        operation: 'rawDecode',
        stage: command.path,
        call: () => Isolate.run(() {
              lowerCurrentThreadPriorityForBackgroundWork();
              final FfiRawNativeBridge bridge =
                  FfiRawNativeBridge.openForCurrentPlatform(
                androidLibraryName: libraryName,
              );
              try {
                return bridge.decode(command);
              } finally {
                bridge.close();
              }
            }));
  }

  @override
  Future<RawNativeFileDecodedFrame> decodeToFile({
    required RawNativeDecodeCommand command,
    required String outputPath,
  }) {
    final String libraryName = androidLibraryName;
    return traceNativeOperation(
        operation: 'rawDecodeToFile',
        stage: command.path,
        call: () => Isolate.run(() {
              lowerCurrentThreadPriorityForBackgroundWork();
              final FfiRawNativeBridge bridge =
                  FfiRawNativeBridge.openForCurrentPlatform(
                androidLibraryName: libraryName,
              );
              try {
                return bridge.decodeToFile(command, outputPath: outputPath);
              } finally {
                bridge.close();
              }
            }));
  }
}

/// メタデータ専用の同期FFI呼び出しをワーカーIsolateへ隔離する。
class FfiRawMetadataProbeWorker implements RawNativeMetadataProbeBackend {
  const FfiRawMetadataProbeWorker({
    this.androidLibraryName = rawNativeLibraryName,
  });

  final String androidLibraryName;

  @override
  Future<RawNativeMetadataFrame> probeMetadata(
    RawNativeMetadataProbeCommand command,
  ) {
    final String libraryName = androidLibraryName;
    return traceNativeOperation(
        operation: 'rawMetadata',
        stage: command.path,
        call: () => Isolate.run(() {
              final FfiRawNativeBridge bridge =
                  FfiRawNativeBridge.openForCurrentPlatform(
                androidLibraryName: libraryName,
              );
              try {
                if (command.expectedFormat == RawFormat.dng &&
                    !bridge.supportsProductionDngMetadata) {
                  throw const RawDecoderUnavailable(
                    'Native RAWライブラリは実DNGメタデータ検査に対応していません。',
                  );
                }
                return bridge.probeMetadata(command);
              } finally {
                bridge.close();
              }
            }));
  }
}
