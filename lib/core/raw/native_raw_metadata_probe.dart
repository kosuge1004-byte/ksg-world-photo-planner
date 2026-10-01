import 'raw_decoder_contract.dart';
import 'raw_format.dart';
import 'raw_metadata_probe.dart';
import 'raw_native_contract.dart';
import 'raw_probe_result.dart';

/// Native RAW ABIのメタデータ専用拡張を安全なDartモデルへ接続する。
class NativeRawMetadataProbe implements RawMetadataProbe {
  NativeRawMetadataProbe({
    required this.backend,
    required Iterable<RawFormat> supportedFormats,
    this.probeId = 'mobile-stack-native-metadata-v1',
  }) : supportedFormats = Set<RawFormat>.unmodifiable(supportedFormats);

  final RawNativeMetadataProbeBackend backend;
  final Set<RawFormat> supportedFormats;
  final String probeId;

  @override
  bool supports(RawFormat format) => supportedFormats.contains(format);

  @override
  Future<RawMetadataProbeResult> probe(RawProbeResult source) async {
    if (!source.isAccepted) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.invalidArgument,
        message: '検査を通過していないRAWのメタデータは取得できません。',
      );
    }
    if (!supports(source.format)) {
      throw RawDecodeFailure(
        code: RawDecodeErrorCode.unsupportedFormat,
        message: '${source.format.label}はメタデータ検査の対象外です。',
      );
    }

    final RawNativeMetadataFrame frame = await backend.probeMetadata(
      RawNativeMetadataProbeCommand(
        path: source.path,
        expectedFormat: source.format,
        expectedByteLength: source.byteLength,
      ),
    );
    _validateFrame(frame, source);

    return RawMetadataProbeResult(
      width: frame.width,
      height: frame.height,
      cfaPattern: frame.cfaPattern,
      metadata: RawFrameMetadata(
        format: frame.format,
        activeArea: frame.activeArea,
        orientation: frame.orientation,
        blackLevels: frame.blackLevels,
        whiteLevel: frame.whiteLevel,
        cameraWhiteBalance: frame.cameraWhiteBalance,
        d65XyzToCamera: frame.d65XyzToCamera,
        baselineExposure: frame.baselineExposure,
        baselineExposureOffset: frame.baselineExposureOffset,
        profileDynamicRange: frame.profileDynamicRange,
        profileHintMaxOutputValue: frame.profileHintMaxOutputValue,
        profileToneCurve: frame.profileToneCurve,
        profileHueSatMap: frame.profileHueSatMap,
        profileLookTable: frame.profileLookTable,
        linearizationTable: frame.linearizationTable,
        blackLevelDeltaH: frame.blackLevelDeltaH,
        blackLevelDeltaV: frame.blackLevelDeltaV,
      ),
      probeId: probeId,
    );
  }

  void _validateFrame(
    RawNativeMetadataFrame frame,
    RawProbeResult source,
  ) {
    if (frame.format != source.format) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'ネイティブメタデータのRAW形式が入力と一致しません。',
      );
    }
    if (frame.width <= 0 || frame.height <= 0) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'RAWメタデータの画像寸法が不正です。',
      );
    }
    if (!frame.activeArea.fitsInside(frame.width, frame.height)) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'RAWメタデータの有効領域が画像範囲外です。',
      );
    }
    if (frame.orientation < 1 || frame.orientation > 8) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'RAWメタデータのOrientation値が不正です。',
      );
    }
    if (!frame.whiteLevel.isFinite ||
        frame.whiteLevel <= 0 ||
        frame.blackLevels.length != 4 ||
        frame.blackLevels.any(
          (double value) =>
              !value.isFinite || value < 0 || value >= frame.whiteLevel,
        )) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'RAWメタデータのブラック／ホワイトレベルが不正です。',
      );
    }

    final List<double>? linearization = frame.linearizationTable;
    if (linearization != null &&
        (linearization.isEmpty ||
            linearization.length > 65536 ||
            linearization.any((double value) =>
                !value.isFinite ||
                value < 0 ||
                value > 65535 ||
                value != value.roundToDouble()))) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'DNG LinearizationTable is invalid.',
      );
    }
    final List<double>? deltaH = frame.blackLevelDeltaH;
    if (deltaH != null &&
        (deltaH.length != frame.activeArea.width ||
            deltaH.any((double value) => !value.isFinite))) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'DNG BlackLevelDeltaH is invalid.',
      );
    }
    final List<double>? deltaV = frame.blackLevelDeltaV;
    if (deltaV != null &&
        (deltaV.length != frame.activeArea.height ||
            deltaV.any((double value) => !value.isFinite))) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'DNG BlackLevelDeltaV is invalid.',
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
        message: 'RAWメタデータのカメラホワイトバランス値が不正です。',
      );
    }
    final List<double>? colorMatrix = frame.d65XyzToCamera;
    if (colorMatrix != null &&
        (colorMatrix.length != 9 ||
            colorMatrix.any((double value) => !value.isFinite))) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'RAWメタデータのD65色行列が不正です。',
      );
    }
    final double? baselineExposure = frame.baselineExposure;
    if (baselineExposure != null &&
        (!baselineExposure.isFinite ||
            baselineExposure < -32 ||
            baselineExposure > 32)) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'RAW baseline exposure is outside the safe range.',
      );
    }
    final double? baselineExposureOffset = frame.baselineExposureOffset;
    if (baselineExposureOffset != null &&
        (!baselineExposureOffset.isFinite ||
            baselineExposureOffset < -32 ||
            baselineExposureOffset > 32)) {
      throw const RawDecodeFailure(
        code: RawDecodeErrorCode.corruptData,
        message: 'DNG baseline exposure offset is outside the safe range.',
      );
    }
    final List<double>? curve = frame.profileToneCurve;
    if (curve != null) {
      if (curve.length < 4 || curve.length > 16384 || curve.length.isOdd) {
        throw const RawDecodeFailure(
          code: RawDecodeErrorCode.corruptData,
          message: 'DNG profile tone curve has an invalid point count.',
        );
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
          throw const RawDecodeFailure(
            code: RawDecodeErrorCode.corruptData,
            message: 'DNG profile tone curve is malformed.',
          );
        }
        previousX = x;
      }
      final bool isHighDynamicRange = frame.profileDynamicRange == 1;
      if (curve[0] != 0 ||
          curve[1] != 0 ||
          (!isHighDynamicRange &&
              (curve[curve.length - 2] != 1 || curve.last != 1))) {
        throw const RawDecodeFailure(
          code: RawDecodeErrorCode.corruptData,
          message: 'DNG profile tone curve endpoints are invalid.',
        );
      }
    }
  }
}
