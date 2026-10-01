import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../quality/processing_precision.dart';
import 'raw_decoder_contract.dart';
import 'raw_format.dart';

const int rawNativeAbiVersion = 1;
const String rawNativeLibraryName = 'libmobile_stack_raw.so';
const int rawNativeCapabilityDecode = 1 << 0;
const int rawNativeCapabilityMetadataProbe = 1 << 1;
const int rawNativeCapabilityConformanceStub = 1 << 2;
const int rawNativeCapabilityDngMetadata = 1 << 3;
const int rawNativeCapabilityArwLosslessJpeg = 1 << 4;
const int rawNativeCapabilitySonyArw2 = 1 << 5;
const int rawNativeCapabilityLibRawSony = 1 << 6;
const int rawNativeCapabilityLibRawNikon = 1 << 7;

enum RawNativeStatus {
  ok(0),
  invalidArgument(1),
  unsupportedFormat(2),
  fileIo(3),
  corruptData(4),
  resourceLimit(5),
  abiMismatch(6),
  outOfMemory(7),
  cancelled(8),
  decodeFailure(9),
  internal(10);

  const RawNativeStatus(this.code);
  final int code;

  static RawNativeStatus fromCode(int code) {
    for (final RawNativeStatus status in values) {
      if (status.code == code) return status;
    }
    return RawNativeStatus.internal;
  }

  RawDecodeErrorCode toDecodeErrorCode() => switch (this) {
        RawNativeStatus.invalidArgument => RawDecodeErrorCode.invalidArgument,
        RawNativeStatus.unsupportedFormat =>
          RawDecodeErrorCode.unsupportedFormat,
        RawNativeStatus.fileIo => RawDecodeErrorCode.fileIo,
        RawNativeStatus.corruptData => RawDecodeErrorCode.corruptData,
        RawNativeStatus.resourceLimit => RawDecodeErrorCode.resourceLimit,
        RawNativeStatus.abiMismatch => RawDecodeErrorCode.abiMismatch,
        RawNativeStatus.outOfMemory => RawDecodeErrorCode.outOfMemory,
        RawNativeStatus.cancelled => RawDecodeErrorCode.cancelled,
        RawNativeStatus.decodeFailure => RawDecodeErrorCode.nativeFailure,
        RawNativeStatus.ok ||
        RawNativeStatus.internal =>
          RawDecodeErrorCode.internal,
      };
}

class RawNativeDecodeCommand {
  const RawNativeDecodeCommand({
    required this.path,
    required this.expectedFormat,
    required this.expectedByteLength,
    required this.outputPrecision,
    required this.maximumPixelCount,
  });

  final String path;
  final RawFormat expectedFormat;
  final int expectedByteLength;
  final ProcessingPrecision outputPrecision;
  final int maximumPixelCount;
}

class RawNativeDecodedFrame {
  RawNativeDecodedFrame({
    required RawFormat format,
    required int width,
    required int height,
    required CfaPattern cfaPattern,
    required RawActiveArea activeArea,
    required int orientation,
    required List<double> blackLevels,
    required double whiteLevel,
    required Float32List samples,
    List<double>? cameraWhiteBalance,
  }) : this._(
          format: format,
          width: width,
          height: height,
          cfaPattern: cfaPattern,
          activeArea: activeArea,
          orientation: orientation,
          blackLevels: blackLevels,
          whiteLevel: whiteLevel,
          samples: Float32List.fromList(samples),
          cameraWhiteBalance: cameraWhiteBalance,
          sampleLease: null,
        );

  /// Takes ownership of an already-private Dart buffer without another
  /// full-frame copy. This is intended for native bridges that have already
  /// copied data out of native-owned memory before releasing that memory.
  /// Callers must not mutate or retain another writable alias to [samples].
  RawNativeDecodedFrame.takeOwnedSamples({
    required RawFormat format,
    required int width,
    required int height,
    required CfaPattern cfaPattern,
    required RawActiveArea activeArea,
    required int orientation,
    required List<double> blackLevels,
    required double whiteLevel,
    required Float32List samples,
    List<double>? cameraWhiteBalance,
    RawSampleLease? sampleLease,
  }) : this._(
          format: format,
          width: width,
          height: height,
          cfaPattern: cfaPattern,
          activeArea: activeArea,
          orientation: orientation,
          blackLevels: blackLevels,
          whiteLevel: whiteLevel,
          samples: samples,
          cameraWhiteBalance: cameraWhiteBalance,
          sampleLease: sampleLease,
        );

  RawNativeDecodedFrame._({
    required this.format,
    required this.width,
    required this.height,
    required this.cfaPattern,
    required this.activeArea,
    required this.orientation,
    required List<double> blackLevels,
    required this.whiteLevel,
    required this.samples,
    List<double>? cameraWhiteBalance,
    this.sampleLease,
  })  : blackLevels = List<double>.unmodifiable(blackLevels),
        cameraWhiteBalance = cameraWhiteBalance == null
            ? null
            : List<double>.unmodifiable(cameraWhiteBalance);

  final RawFormat format;
  final int width;
  final int height;
  final CfaPattern cfaPattern;
  final RawActiveArea activeArea;
  final int orientation;
  final List<double> blackLevels;
  final double whiteLevel;
  final List<double>? cameraWhiteBalance;

  /// ネイティブ所有メモリではなく、Dartが所有する独立コピー。
  final Float32List samples;
  final RawSampleLease? sampleLease;
}

abstract interface class RawNativeDecodeBackend {
  Future<RawNativeDecodedFrame> decode(RawNativeDecodeCommand command);
}

/// Metadata returned by the native decode-to-file path. Unlike
/// [RawNativeDecodedFrame], the sensor samples are already persisted in
/// [samplePath] and no full-frame Float32List is materialized in Dart.
class RawNativeFileDecodedFrame {
  RawNativeFileDecodedFrame({
    required this.format,
    required this.width,
    required this.height,
    required this.cfaPattern,
    required this.activeArea,
    required this.orientation,
    required List<double> blackLevels,
    required this.whiteLevel,
    required this.samplePath,
    List<double>? cameraWhiteBalance,
  })  : blackLevels = List<double>.unmodifiable(blackLevels),
        cameraWhiteBalance = cameraWhiteBalance == null
            ? null
            : List<double>.unmodifiable(cameraWhiteBalance);

  final RawFormat format;
  final int width;
  final int height;
  final CfaPattern cfaPattern;
  final RawActiveArea activeArea;
  final int orientation;
  final List<double> blackLevels;
  final double whiteLevel;
  final List<double>? cameraWhiteBalance;
  final String samplePath;
}

abstract interface class RawNativeFileDecodeBackend {
  Future<RawNativeFileDecodedFrame> decodeToFile({
    required RawNativeDecodeCommand command,
    required String outputPath,
  });
}

class RawNativeMetadataProbeCommand {
  const RawNativeMetadataProbeCommand({
    required this.path,
    required this.expectedFormat,
    required this.expectedByteLength,
  });

  final String path;
  final RawFormat expectedFormat;
  final int expectedByteLength;
}

class RawNativeMetadataFrame {
  RawNativeMetadataFrame({
    required this.format,
    required this.width,
    required this.height,
    required this.cfaPattern,
    required this.activeArea,
    required this.orientation,
    required List<double> blackLevels,
    required this.whiteLevel,
    List<double>? cameraWhiteBalance,
    List<double>? d65XyzToCamera,
    this.baselineExposure,
    this.baselineExposureOffset,
    this.profileDynamicRange,
    this.profileHintMaxOutputValue,
    List<double>? profileToneCurve,
    this.profileHueSatMap,
    this.profileLookTable,
    List<double>? linearizationTable,
    List<double>? blackLevelDeltaH,
    List<double>? blackLevelDeltaV,
  })  : blackLevels = List<double>.unmodifiable(blackLevels),
        cameraWhiteBalance = cameraWhiteBalance == null
            ? null
            : List<double>.unmodifiable(cameraWhiteBalance),
        d65XyzToCamera = d65XyzToCamera == null
            ? null
            : List<double>.unmodifiable(d65XyzToCamera),
        profileToneCurve = profileToneCurve == null
            ? null
            : List<double>.unmodifiable(profileToneCurve),
        linearizationTable = linearizationTable == null
            ? null
            : List<double>.unmodifiable(linearizationTable),
        blackLevelDeltaH = blackLevelDeltaH == null
            ? null
            : List<double>.unmodifiable(blackLevelDeltaH),
        blackLevelDeltaV = blackLevelDeltaV == null
            ? null
            : List<double>.unmodifiable(blackLevelDeltaV);

  final RawFormat format;
  final int width;
  final int height;
  final CfaPattern cfaPattern;
  final RawActiveArea activeArea;
  final int orientation;
  final List<double> blackLevels;
  final double whiteLevel;
  final List<double>? cameraWhiteBalance;
  final List<double>? d65XyzToCamera;
  final double? baselineExposure;
  final double? baselineExposureOffset;
  final int? profileDynamicRange;
  final double? profileHintMaxOutputValue;
  final List<double>? profileToneCurve;
  final RawProfileHueSatMap? profileHueSatMap;
  final RawProfileLookTable? profileLookTable;
  final List<double>? linearizationTable;
  final List<double>? blackLevelDeltaH;
  final List<double>? blackLevelDeltaV;
}

abstract interface class RawNativeMetadataProbeBackend {
  Future<RawNativeMetadataFrame> probeMetadata(
    RawNativeMetadataProbeCommand command,
  );
}

int rawFormatToNativeCode(RawFormat format) => switch (format) {
      RawFormat.arw => 1,
      RawFormat.cr2 => 2,
      RawFormat.cr3 => 3,
      RawFormat.dng => 4,
      RawFormat.nef => 5,
      RawFormat.nrw => 6,
      RawFormat.orf => 7,
      RawFormat.pef => 8,
      RawFormat.raf => 9,
      RawFormat.rw2 => 10,
      RawFormat.unknown => 0,
    };

RawFormat rawFormatFromNativeCode(int code) => switch (code) {
      1 => RawFormat.arw,
      2 => RawFormat.cr2,
      3 => RawFormat.cr3,
      4 => RawFormat.dng,
      5 => RawFormat.nef,
      6 => RawFormat.nrw,
      7 => RawFormat.orf,
      8 => RawFormat.pef,
      9 => RawFormat.raf,
      10 => RawFormat.rw2,
      _ => RawFormat.unknown,
    };

int precisionToNativeCode(ProcessingPrecision precision) => switch (precision) {
      ProcessingPrecision.sourceInteger => 1,
      ProcessingPrecision.float32 => 2,
      ProcessingPrecision.float64 => 3,
    };

CfaPattern? cfaPatternFromNativeCode(int code) => switch (code) {
      1 => CfaPattern.rggb,
      2 => CfaPattern.bggr,
      3 => CfaPattern.grbg,
      4 => CfaPattern.gbrg,
      _ => null,
    };
