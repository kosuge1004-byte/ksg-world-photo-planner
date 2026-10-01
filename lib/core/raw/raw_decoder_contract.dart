import '../image/cfa_pattern.dart';
import '../image/linear_raw_mosaic.dart';
import '../quality/processing_precision.dart';
import 'raw_format.dart';
import 'raw_probe_result.dart';

const int defaultMaximumRawPixelCount = 64000000;

class RawDecodeRequest {
  const RawDecodeRequest({
    required this.probe,
    this.outputPrecision = ProcessingPrecision.float32,
    this.maximumPixelCount = defaultMaximumRawPixelCount,
  }) : assert(maximumPixelCount > 0);

  final RawProbeResult probe;
  final ProcessingPrecision outputPrecision;

  /// 品質を落として続行せず、超過時は明示的に失敗させる上限。
  final int maximumPixelCount;
}

class RawDecodeDescriptor {
  RawDecodeDescriptor({
    required Iterable<RawFormat> supportedFormats,
    required this.decoderId,
    required this.nativeBackendRequired,
    required this.minimumAbiVersion,
    required this.maximumAbiVersion,
  }) : supportedFormats = Set<RawFormat>.unmodifiable(supportedFormats) {
    if (this.supportedFormats.isEmpty) {
      throw ArgumentError.value(
        supportedFormats,
        'supportedFormats',
        '1形式以上が必要です。',
      );
    }
    if (minimumAbiVersion <= 0 || maximumAbiVersion < minimumAbiVersion) {
      throw ArgumentError('ABIバージョン範囲が不正です。');
    }
  }

  final Set<RawFormat> supportedFormats;
  final String decoderId;
  final bool nativeBackendRequired;
  final int minimumAbiVersion;
  final int maximumAbiVersion;
}

class RawActiveArea {
  const RawActiveArea({
    required this.left,
    required this.top,
    required this.width,
    required this.height,
  });

  final int left;
  final int top;
  final int width;
  final int height;

  bool fitsInside(int imageWidth, int imageHeight) {
    if (left < 0 || top < 0 || width <= 0 || height <= 0) return false;
    if (left > imageWidth || top > imageHeight) return false;
    return width <= imageWidth - left && height <= imageHeight - top;
  }
}

class RawFrameMetadata {
  RawFrameMetadata({
    required this.format,
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
            : List<double>.unmodifiable(blackLevelDeltaV) {
    if (this.blackLevels.length != 4) {
      throw ArgumentError.value(
        blackLevels,
        'blackLevels',
        '4要素が必要です。',
      );
    }
    final List<double>? whiteBalance = this.cameraWhiteBalance;
    if (whiteBalance != null && whiteBalance.length != 4) {
      throw ArgumentError.value(
        cameraWhiteBalance,
        'cameraWhiteBalance',
        '4要素が必要です。',
      );
    }
    final List<double>? colorMatrix = this.d65XyzToCamera;
    if (colorMatrix != null &&
        (colorMatrix.length != 9 ||
            colorMatrix.any((double value) => !value.isFinite))) {
      throw ArgumentError.value(
        d65XyzToCamera,
        'd65XyzToCamera',
        '9個の有限値が必要です。',
      );
    }
    if (orientation < 1 || orientation > 8) {
      throw ArgumentError.value(orientation, 'orientation');
    }
    final double? exposure = baselineExposure;
    if (exposure != null &&
        (!exposure.isFinite || exposure < -32 || exposure > 32)) {
      throw ArgumentError.value(
        baselineExposure,
        'baselineExposure',
        'must be finite and between -32 and 32 EV',
      );
    }
    final double? exposureOffset = baselineExposureOffset;
    if (exposureOffset != null &&
        (!exposureOffset.isFinite ||
            exposureOffset < -32 ||
            exposureOffset > 32)) {
      throw ArgumentError.value(
        baselineExposureOffset,
        'baselineExposureOffset',
        'must be finite and between -32 and 32 EV',
      );
    }
    final int? dynamicRange = profileDynamicRange;
    if (dynamicRange != null && dynamicRange != 0 && dynamicRange != 1) {
      throw ArgumentError.value(
        profileDynamicRange,
        'profileDynamicRange',
        'must be 0 (SDR) or 1 (HDR)',
      );
    }
    final double? hintMax = profileHintMaxOutputValue;
    if (hintMax != null && dynamicRange == null) {
      throw ArgumentError.value(
        profileHintMaxOutputValue,
        'profileHintMaxOutputValue',
        'requires profileDynamicRange because both fields belong to one DNG tag',
      );
    }
    if (hintMax != null &&
        (!hintMax.isFinite || (dynamicRange == 0 && hintMax > 1))) {
      throw ArgumentError.value(
        profileHintMaxOutputValue,
        'profileHintMaxOutputValue',
        'must be finite; SDR hints must be <= 1',
      );
    }
    _validateProfileToneCurve(
      this.profileToneCurve,
      isHighDynamicRange: dynamicRange == 1,
    );
    final List<double>? linearization = this.linearizationTable;
    if (linearization != null &&
        (linearization.isEmpty ||
            linearization.length > 65536 ||
            linearization.any((double value) =>
                !value.isFinite ||
                value < 0 ||
                value > 65535 ||
                value != value.roundToDouble()))) {
      throw ArgumentError.value(
        linearizationTable,
        'linearizationTable',
        'must contain 1..65536 finite integer values in 0..65535',
      );
    }
    final List<double>? deltaH = this.blackLevelDeltaH;
    if (deltaH != null &&
        (deltaH.length != activeArea.width ||
            deltaH.any((double value) => !value.isFinite))) {
      throw ArgumentError.value(
        deltaH,
        'blackLevelDeltaH',
        'must match ActiveArea width and contain finite values',
      );
    }
    final List<double>? deltaV = this.blackLevelDeltaV;
    if (deltaV != null &&
        (deltaV.length != activeArea.height ||
            deltaV.any((double value) => !value.isFinite))) {
      throw ArgumentError.value(
        deltaV,
        'blackLevelDeltaV',
        'must match ActiveArea height and contain finite values',
      );
    }
  }

  final RawFormat format;
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

  double? get totalBaselineExposure {
    if (baselineExposure == null && baselineExposureOffset == null) return null;
    return (baselineExposure ?? 0) + (baselineExposureOffset ?? 0);
  }
}

/// Uses decoded metadata as authoritative sensor data and fills only missing
/// optional render-profile values from a probe of the same source frame.
RawFrameMetadata mergeSameFrameRawMetadata({
  required RawFrameMetadata decoded,
  RawFrameMetadata? probed,
}) {
  if (probed == null) return decoded;
  if (decoded.format != probed.format) {
    throw ArgumentError('Decoded and probed metadata formats must match.');
  }
  return RawFrameMetadata(
    format: decoded.format,
    activeArea: decoded.activeArea,
    orientation: decoded.orientation,
    blackLevels: decoded.blackLevels,
    whiteLevel: decoded.whiteLevel,
    cameraWhiteBalance: decoded.cameraWhiteBalance ?? probed.cameraWhiteBalance,
    d65XyzToCamera: decoded.d65XyzToCamera ?? probed.d65XyzToCamera,
    baselineExposure: decoded.baselineExposure ?? probed.baselineExposure,
    baselineExposureOffset:
        decoded.baselineExposureOffset ?? probed.baselineExposureOffset,
    // ProfileDynamicRange is one DNG tag containing both DynamicRange and
    // HintMaxOutputValue. Keep the tag atomic when filling decoder gaps:
    // never combine a DynamicRange value from one parser result with the
    // hint field from the other parser result, even though both describe the
    // same source frame. HDR/SDR selection changes clipping and profile-table
    // math, so a mixed tag would be semantically invalid.
    profileDynamicRange:
        decoded.profileDynamicRange ?? probed.profileDynamicRange,
    profileHintMaxOutputValue: decoded.profileDynamicRange != null
        ? decoded.profileHintMaxOutputValue
        : probed.profileHintMaxOutputValue,
    profileToneCurve: decoded.profileToneCurve ?? probed.profileToneCurve,
    profileHueSatMap: decoded.profileHueSatMap ?? probed.profileHueSatMap,
    profileLookTable: decoded.profileLookTable ?? probed.profileLookTable,
    linearizationTable: decoded.linearizationTable ?? probed.linearizationTable,
    blackLevelDeltaH:
        decoded.blackLevelDeltaH ?? _normalizedHorizontalBlackDelta(probed),
    blackLevelDeltaV:
        decoded.blackLevelDeltaV ?? _normalizedVerticalBlackDelta(probed),
  );
}

List<double>? _normalizedHorizontalBlackDelta(RawFrameMetadata metadata) {
  final List<double>? h = metadata.blackLevelDeltaH;
  final List<double>? v = metadata.blackLevelDeltaV;
  if (h == null && v == null) return null;
  return switch (metadata.orientation) {
    1 || 4 => h,
    2 || 3 => h?.reversed.toList(growable: false),
    5 || 8 => v,
    6 || 7 => v?.reversed.toList(growable: false),
    _ => throw ArgumentError.value(metadata.orientation, 'orientation'),
  };
}

List<double>? _normalizedVerticalBlackDelta(RawFrameMetadata metadata) {
  final List<double>? h = metadata.blackLevelDeltaH;
  final List<double>? v = metadata.blackLevelDeltaV;
  if (h == null && v == null) return null;
  return switch (metadata.orientation) {
    1 || 2 => v,
    3 || 4 => v?.reversed.toList(growable: false),
    5 || 6 => h,
    7 || 8 => h?.reversed.toList(growable: false),
    _ => throw ArgumentError.value(metadata.orientation, 'orientation'),
  };
}

final class RawProfileHueSatMap {
  RawProfileHueSatMap({
    required this.hueDivisions,
    required this.saturationDivisions,
    required this.valueDivisions,
    required this.encoding,
    required List<double> deltas,
  }) : deltas = List<double>.unmodifiable(deltas) {
    final int entryCount = hueDivisions * saturationDivisions * valueDivisions;
    if (hueDivisions < 1 ||
        hueDivisions > 360 ||
        saturationDivisions < 2 ||
        saturationDivisions > 256 ||
        valueDivisions < 1 ||
        valueDivisions > 64 ||
        entryCount > 262144 ||
        encoding < 0 ||
        encoding > 1 ||
        this.deltas.length != entryCount * 3) {
      throw ArgumentError('Invalid DNG profile hue/saturation map shape.');
    }
    for (int index = 0; index < this.deltas.length; index += 3) {
      final double hueShift = this.deltas[index];
      final double saturationScale = this.deltas[index + 1];
      final double valueScale = this.deltas[index + 2];
      if (!hueShift.isFinite ||
          hueShift < -3600 ||
          hueShift > 3600 ||
          !saturationScale.isFinite ||
          saturationScale < 0 ||
          saturationScale > 64 ||
          !valueScale.isFinite ||
          valueScale < 0 ||
          valueScale > 64) {
        throw ArgumentError('Invalid DNG profile hue/saturation map entry.');
      }
    }
    // DNG 1.7.1 requires every zero-input-saturation entry to keep
    // Value unchanged. The table is value-major, then hue, then saturation,
    // so saturation index 0 is the first triplet in every hue/value row.
    for (int value = 0; value < valueDivisions; value++) {
      for (int hue = 0; hue < hueDivisions; hue++) {
        final int zeroSaturation =
            (((value * hueDivisions + hue) * saturationDivisions) * 3) + 2;
        if (this.deltas[zeroSaturation] != 1.0) {
          throw ArgumentError(
            'DNG profile hue/saturation map zero-saturation value scale must be 1.0.',
          );
        }
      }
    }
  }

  final int hueDivisions;
  final int saturationDivisions;
  final int valueDivisions;
  final int encoding;
  final List<double> deltas;

  int get entryCount => hueDivisions * saturationDivisions * valueDivisions;
}

final class RawProfileLookTable {
  RawProfileLookTable({
    required this.hueDivisions,
    required this.saturationDivisions,
    required this.valueDivisions,
    required this.encoding,
    required List<double> deltas,
  }) : deltas = List<double>.unmodifiable(deltas) {
    final int entryCount = hueDivisions * saturationDivisions * valueDivisions;
    if (hueDivisions < 1 ||
        hueDivisions > 360 ||
        saturationDivisions < 2 ||
        saturationDivisions > 256 ||
        valueDivisions < 1 ||
        valueDivisions > 64 ||
        entryCount > 262144 ||
        encoding < 0 ||
        encoding > 1 ||
        this.deltas.length != entryCount * 3) {
      throw ArgumentError('Invalid DNG profile look table shape.');
    }
    for (int index = 0; index < this.deltas.length; index += 3) {
      final double hueShift = this.deltas[index];
      final double saturationScale = this.deltas[index + 1];
      final double valueScale = this.deltas[index + 2];
      if (!hueShift.isFinite ||
          hueShift < -3600 ||
          hueShift > 3600 ||
          !saturationScale.isFinite ||
          saturationScale < 0 ||
          saturationScale > 64 ||
          !valueScale.isFinite ||
          valueScale < 0 ||
          valueScale > 64) {
        throw ArgumentError('Invalid DNG profile look table entry.');
      }
    }
    // ProfileLookTable uses the same table format as ProfileHueSatMap.
    // DNG 1.7.1 therefore requires Value scale == 1.0 for every zero-input-
    // saturation entry here as well, preserving the achromatic axis.
    for (int value = 0; value < valueDivisions; value++) {
      for (int hue = 0; hue < hueDivisions; hue++) {
        final int zeroSaturation =
            (((value * hueDivisions + hue) * saturationDivisions) * 3) + 2;
        if (this.deltas[zeroSaturation] != 1.0) {
          throw ArgumentError(
            'DNG profile look table zero-saturation value scale must be 1.0.',
          );
        }
      }
    }
  }

  final int hueDivisions;
  final int saturationDivisions;
  final int valueDivisions;
  final int encoding;
  final List<double> deltas;

  int get entryCount => hueDivisions * saturationDivisions * valueDivisions;
}

void _validateProfileToneCurve(
  List<double>? curve, {
  required bool isHighDynamicRange,
}) {
  if (curve == null) {
    return;
  }
  if (curve.length < 4 || curve.length > 16384 || curve.length.isOdd) {
    throw ArgumentError.value(curve, 'profileToneCurve');
  }
  // DNG 1.7.1 endpoint contract: every profile curve starts at (0,0).
  // SDR curves must also terminate at (1,1); HDR curves may end earlier and
  // use final-slope extension for encoded overrange values. Rejecting invalid
  // endpoints prevents malformed profile metadata from changing black/white
  // rendering in the final image.
  if (curve[0] != 0 || curve[1] != 0) {
    throw ArgumentError.value(curve, 'profileToneCurve');
  }
  if (!isHighDynamicRange &&
      (curve[curve.length - 2] != 1 || curve[curve.length - 1] != 1)) {
    throw ArgumentError.value(curve, 'profileToneCurve');
  }
  double previousX = -1;
  for (int index = 0; index < curve.length; index += 2) {
    final double x = curve[index];
    final double y = curve[index + 1];
    if (!x.isFinite ||
        !y.isFinite ||
        x < 0 ||
        x > 1 ||
        y < 0 ||
        y > 1 ||
        (index != 0 && x <= previousX)) {
      throw ArgumentError.value(curve, 'profileToneCurve');
    }
    previousX = x;
  }
}

abstract interface class RawSampleLease {
  bool get isReleased;
  void release();
}

class RawDecodeResult {
  const RawDecodeResult({
    required this.mosaic,
    required this.metadata,
    required this.decoderId,
    this.sampleLease,
  });

  final LinearRawMosaic mosaic;
  final RawFrameMetadata metadata;
  final String decoderId;
  final RawSampleLease? sampleLease;
}

class RawFileBackedDecodeResult {
  const RawFileBackedDecodeResult({
    required this.samplePath,
    required this.width,
    required this.height,
    required this.cfaPattern,
    required this.metadata,
    required this.decoderId,
  });

  final String samplePath;
  final int width;
  final int height;
  final CfaPattern cfaPattern;
  final RawFrameMetadata metadata;
  final String decoderId;
}

abstract interface class RawFileBackedDecoder {
  bool get supportsFileBackedDecode;

  Future<RawFileBackedDecodeResult> decodeToFileBacked(
    RawDecodeRequest request, {
    required String outputPath,
  });
}

abstract interface class RawDecoder {
  RawDecodeDescriptor get descriptor;

  bool supports(RawFormat format);

  Future<RawDecodeResult> decode(RawDecodeRequest request);
}

enum RawDecodeErrorCode {
  invalidArgument,
  unsupportedFormat,
  fileIo,
  corruptData,
  resourceLimit,
  abiMismatch,
  outOfMemory,
  cancelled,
  nativeFailure,
  internal;
}

class RawDecodeFailure implements Exception {
  const RawDecodeFailure({
    required this.code,
    required this.message,
    this.nativeCode,
  });

  final RawDecodeErrorCode code;
  final String message;
  final int? nativeCode;

  @override
  String toString() {
    final String suffix = nativeCode == null ? '' : ' (native=$nativeCode)';
    return '$message$suffix';
  }
}

class RawDecoderUnavailable implements Exception {
  const RawDecoderUnavailable(this.message);
  final String message;

  @override
  String toString() => message;
}
