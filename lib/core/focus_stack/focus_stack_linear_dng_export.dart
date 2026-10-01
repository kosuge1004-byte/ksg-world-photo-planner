import '../color/raw_camera_color_profile.dart';
import '../export/linear_dng_writer.dart';
import 'focus_stack_pipeline.dart';

final class FocusStackLinearDngExportError extends ArgumentError {
  FocusStackLinearDngExportError(String super.message);
}

/// Exports the focus-stack result as 32-bit float Linear DNG.
///
/// The stack remains in linear camera RGB until this call. A single
/// reference-frame camera profile is then applied by the existing Linear-DNG
/// writer during serialization, producing white-balanced scene-linear
/// sRGB/D65 exactly once.
///
/// No per-frame white balance is baked before blending, so there cannot be
/// color-temperature seams at focus boundaries.
Future<void> exportFocusStackLinearDng({
  required FocusStackPipelineResult result,
  required String outputPath,
  int tileSize = 512,
  LinearDngCompression compression = LinearDngCompression.none,
  bool Function()? isCancelled,
}) async {
  if (outputPath.trim().isEmpty) {
    throw FocusStackLinearDngExportError('Output path must not be empty.');
  }
  if (tileSize < 32 || tileSize > 4096) {
    throw FocusStackLinearDngExportError('Invalid DNG export tile size.');
  }

  final List<double>? matrix = result.referenceMetadata.d65XyzToCamera;
  final List<double>? whiteBalance =
      result.referenceMetadata.cameraWhiteBalance;
  if (matrix == null || whiteBalance == null) {
    throw FocusStackLinearDngExportError(
      'Reference RAW does not contain the color metadata required for '
      'scene-linear DNG export.',
    );
  }

  final RawCameraColorProfile profile = RawCameraColorProfile(
    d65XyzToCamera: matrix,
    phaseWhiteBalance: whiteBalance,
  );

  if (!result.cameraRgbStore.isCommitted) {
    throw FocusStackLinearDngExportError(
      'Focus-stack RGB store is not committed.',
    );
  }

  await exportTileStoreToLinearDng(
    tileStore: result.cameraRgbStore,
    outputPath: outputPath,
    inputToLinearSrgb: profile.outputTransform(result.cfaPattern),
    transparencyMaskSource: result.coverageMask,
    compression: compression,
    isCancelled: isCancelled,
  );
}
