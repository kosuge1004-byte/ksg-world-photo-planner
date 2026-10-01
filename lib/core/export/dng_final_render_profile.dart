import '../color/dng_d65_color_transform.dart';
import '../color/linear_rgb_color_transform.dart';
import '../color/raw_camera_color_profile.dart';
import '../image/cfa_pattern.dart';
import '../raw/raw_decoder_contract.dart';
import 'dng_profile_hue_sat_map.dart';
import 'dng_profile_look_table.dart';
import 'dng_profile_tone_curve.dart';

/// All final-render data selected atomically from one reference RAW frame.
///
/// Keeping these values in one immutable object prevents a color matrix from
/// one input being combined with profile tables or exposure metadata from a
/// different input in a multi-frame stack.
final class DngFinalRenderProfile {
  DngFinalRenderProfile._({
    required this.sourceId,
    required this.linearColorTransform,
    required this.postProfileColorTransform,
    required this.linearDngColorTransform,
    required this.baselineExposureEv,
    required this.hueSatMap,
    required this.lookTable,
    required this.toneCurve,
    required this.isHighDynamicRange,
    required this.hintMaxOutputValue,
  });

  factory DngFinalRenderProfile.fromMetadata({
    required String sourceId,
    required RawFrameMetadata metadata,
    required CfaPattern cfaPattern,
  }) {
    if (sourceId.isEmpty) {
      throw ArgumentError.value(sourceId, 'sourceId', 'must not be empty');
    }
    final double baselineExposureEv = metadata.totalBaselineExposure ?? 0;
    if (!baselineExposureEv.isFinite ||
        baselineExposureEv < -32 ||
        baselineExposureEv > 32) {
      throw ArgumentError.value(
        baselineExposureEv,
        'metadata.totalBaselineExposure',
        'must be finite and between -32 and 32 EV',
      );
    }

    final RawProfileHueSatMap? rawHueSatMap = metadata.profileHueSatMap;
    final RawProfileLookTable? rawLookTable = metadata.profileLookTable;
    final bool isHighDynamicRange = metadata.profileDynamicRange == 1;
    final bool requiresDngProfileWorkingSpace =
        rawHueSatMap != null || rawLookTable != null;
    LinearRgbColorTransform? linearColorTransform;
    LinearRgbColorTransform? postProfileColorTransform;
    if (metadata.d65XyzToCamera != null &&
        metadata.cameraWhiteBalance != null) {
      final RawCameraColorProfile rawProfile = RawCameraColorProfile(
        d65XyzToCamera: metadata.d65XyzToCamera!,
        phaseWhiteBalance: metadata.cameraWhiteBalance!,
      );
      if (requiresDngProfileWorkingSpace) {
        linearColorTransform = linearProPhotoTransformFromDngD65(
          xyzToCameraD65: rawProfile.d65XyzToCamera,
          cameraWhiteBalanceRgb:
              rawProfile.normalizedRgbWhiteBalance(cfaPattern),
        );
        postProfileColorTransform = linearSrgbTransformFromLinearProPhoto();
      } else {
        linearColorTransform = rawProfile.outputTransform(cfaPattern);
      }
    }

    final bool canApplyDngProfileTables =
        !requiresDngProfileWorkingSpace || postProfileColorTransform != null;
    final List<double>? rawToneCurve = metadata.profileToneCurve;
    final LinearRgbColorTransform? linearDngColorTransform =
        _composeLinearDngTransform(
      linearColorTransform,
      postProfileColorTransform,
    );
    return DngFinalRenderProfile._(
      sourceId: sourceId,
      linearColorTransform: linearColorTransform,
      postProfileColorTransform: postProfileColorTransform,
      linearDngColorTransform: linearDngColorTransform,
      baselineExposureEv: baselineExposureEv,
      hueSatMap: rawHueSatMap == null || !canApplyDngProfileTables
          ? null
          : DngProfileHueSatMap(
              hueDivisions: rawHueSatMap.hueDivisions,
              saturationDivisions: rawHueSatMap.saturationDivisions,
              valueDivisions: rawHueSatMap.valueDivisions,
              encoding: rawHueSatMap.encoding,
              deltas: rawHueSatMap.deltas,
              // DNG 1.7.1: omitted ProfileDynamicRange means SDR; an
              // explicit DynamicRange=1 enables the overrange transform.
              isHighDynamicRange: isHighDynamicRange,
            ),
      lookTable: rawLookTable == null || !canApplyDngProfileTables
          ? null
          : DngProfileLookTable(
              hueDivisions: rawLookTable.hueDivisions,
              saturationDivisions: rawLookTable.saturationDivisions,
              valueDivisions: rawLookTable.valueDivisions,
              encoding: rawLookTable.encoding,
              deltas: rawLookTable.deltas,
              isHighDynamicRange: isHighDynamicRange,
            ),
      toneCurve: rawToneCurve == null
          ? null
          : DngProfileToneCurve.fromInterleaved(
              rawToneCurve,
              isHighDynamicRange: isHighDynamicRange,
            ),
      isHighDynamicRange: isHighDynamicRange,
      hintMaxOutputValue: metadata.profileHintMaxOutputValue,
    );
  }

  /// Builds the DNG render stages that belong *after* an already-selected
  /// linear color transform. This is used by pipelines such as CFA drizzle,
  /// where white balance is harmonized across multiple compatible RAW frames
  /// before demosaic/export, so re-applying one frame's own linear transform
  /// would be incorrect.
  ///
  /// BaselineExposure, ProfileHueSatMap, ProfileLookTable and ProfileToneCurve
  /// still come atomically from one representative RAW. The linear transform
  /// is intentionally null.
  factory DngFinalRenderProfile.postColorFromMetadata({
    required String sourceId,
    required RawFrameMetadata metadata,
    required bool inputIsLinearProPhoto,
  }) {
    if (sourceId.isEmpty) {
      throw ArgumentError.value(sourceId, 'sourceId', 'must not be empty');
    }
    final double baselineExposureEv = metadata.totalBaselineExposure ?? 0;
    if (!baselineExposureEv.isFinite ||
        baselineExposureEv < -32 ||
        baselineExposureEv > 32) {
      throw ArgumentError.value(
        baselineExposureEv,
        'metadata.totalBaselineExposure',
        'must be finite and between -32 and 32 EV',
      );
    }

    final RawProfileHueSatMap? rawHueSatMap = metadata.profileHueSatMap;
    final RawProfileLookTable? rawLookTable = metadata.profileLookTable;
    final bool isHighDynamicRange = metadata.profileDynamicRange == 1;
    final List<double>? rawToneCurve = metadata.profileToneCurve;
    final bool requiresDngProfileWorkingSpace =
        rawHueSatMap != null || rawLookTable != null;
    final bool canApplyDngProfileTables =
        !requiresDngProfileWorkingSpace || inputIsLinearProPhoto;
    final LinearRgbColorTransform linearDngColorTransform =
        inputIsLinearProPhoto
            ? linearSrgbTransformFromLinearProPhoto()
            : LinearRgbColorTransform.identity();
    return DngFinalRenderProfile._(
      sourceId: sourceId,
      linearColorTransform: null,
      postProfileColorTransform:
          requiresDngProfileWorkingSpace && inputIsLinearProPhoto
              ? linearSrgbTransformFromLinearProPhoto()
              : null,
      linearDngColorTransform: linearDngColorTransform,
      baselineExposureEv: baselineExposureEv,
      hueSatMap: rawHueSatMap == null || !canApplyDngProfileTables
          ? null
          : DngProfileHueSatMap(
              hueDivisions: rawHueSatMap.hueDivisions,
              saturationDivisions: rawHueSatMap.saturationDivisions,
              valueDivisions: rawHueSatMap.valueDivisions,
              encoding: rawHueSatMap.encoding,
              deltas: rawHueSatMap.deltas,
              // DNG 1.7.1: omitted ProfileDynamicRange means SDR; an
              // explicit DynamicRange=1 enables the overrange transform.
              isHighDynamicRange: isHighDynamicRange,
            ),
      lookTable: rawLookTable == null || !canApplyDngProfileTables
          ? null
          : DngProfileLookTable(
              hueDivisions: rawLookTable.hueDivisions,
              saturationDivisions: rawLookTable.saturationDivisions,
              valueDivisions: rawLookTable.valueDivisions,
              encoding: rawLookTable.encoding,
              deltas: rawLookTable.deltas,
              isHighDynamicRange: isHighDynamicRange,
            ),
      toneCurve: rawToneCurve == null
          ? null
          : DngProfileToneCurve.fromInterleaved(
              rawToneCurve,
              isHighDynamicRange: isHighDynamicRange,
            ),
      isHighDynamicRange: isHighDynamicRange,
      hintMaxOutputValue: metadata.profileHintMaxOutputValue,
    );
  }

  final String sourceId;
  final LinearRgbColorTransform? linearColorTransform;
  final LinearRgbColorTransform? postProfileColorTransform;

  /// Linear-only transform used for Linear DNG export. It deliberately
  /// excludes BaselineExposure, profile LUTs, tone curves and gamma.
  final LinearRgbColorTransform? linearDngColorTransform;
  final double baselineExposureEv;
  final DngProfileHueSatMap? hueSatMap;
  final DngProfileLookTable? lookTable;
  final DngProfileToneCurve? toneCurve;
  final bool isHighDynamicRange;
  final double? hintMaxOutputValue;

  bool get hasAdjustments =>
      linearColorTransform != null ||
      postProfileColorTransform != null ||
      baselineExposureEv != 0 ||
      hueSatMap != null ||
      lookTable != null ||
      toneCurve != null;
}

LinearRgbColorTransform? _composeLinearDngTransform(
  LinearRgbColorTransform? first,
  LinearRgbColorTransform? second,
) {
  if (first == null) return null;
  if (second == null) return first;
  final List<double> a = first.matrix;
  final List<double> b = second.matrix;
  final List<double> composed = List<double>.filled(9, 0);
  for (int row = 0; row < 3; row++) {
    for (int column = 0; column < 3; column++) {
      double sum = 0;
      for (int k = 0; k < 3; k++) {
        sum += b[row * 3 + k] * a[k * 3 + column];
      }
      composed[row * 3 + column] = sum;
    }
  }
  return LinearRgbColorTransform(
    matrix: composed,
    sourceDescription: first.sourceDescription,
    destinationDescription: 'linear sRGB (D65) for Linear DNG',
  );
}
