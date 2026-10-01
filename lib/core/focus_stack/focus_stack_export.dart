import '../export/dng_final_render_profile.dart';
import '../export/export_result.dart';
import '../export/output_image_format.dart';
import '../export/linear_dng_writer.dart';
import 'focus_stack_linear_dng_export.dart';
import 'focus_stack_pipeline.dart';

/// Exports a completed focus stack using the user-selected final format.
///
/// JPEG/TIFF are rendered from the unchanged full-resolution linear camera-RGB
/// result. Linear DNG keeps the dedicated scene-linear path and coverage mask.
Future<void> exportFocusStackResult({
  required FocusStackPipelineResult result,
  required String outputPath,
  required OutputImageFormat format,
  LinearDngCompression linearDngCompression = LinearDngCompression.none,
  bool Function()? isCancelled,
}) async {
  if (format == OutputImageFormat.linearDng) {
    await exportFocusStackLinearDng(
      result: result,
      outputPath: outputPath,
      compression: linearDngCompression,
      isCancelled: isCancelled,
    );
    return;
  }
  if (format == OutputImageFormat.bmp8) {
    throw ArgumentError('BMP is not a selectable focus-stack output format.');
  }

  final DngFinalRenderProfile renderProfile =
      DngFinalRenderProfile.fromMetadata(
    sourceId: result.decoderId,
    metadata: result.referenceMetadata,
    cfaPattern: result.cfaPattern,
  );
  await exportTileStoreToImage(
    tileStore: result.cameraRgbStore,
    outputPath: outputPath,
    format: format,
    renderProfile: renderProfile,
    isCancelled: isCancelled,
  );
}
