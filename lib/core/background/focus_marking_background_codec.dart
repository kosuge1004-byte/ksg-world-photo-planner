import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../focus_stack/focus_exact_preview.dart';
import '../focus_stack/focus_frame_selection_policy.dart';
import '../focus_stack/focus_marking_analysis_pipeline.dart';
import '../focus_stack/high_precision_focus_marking.dart';

final class FocusMarkingBackgroundResult {
  const FocusMarkingBackgroundResult({
    required this.analysis,
    required this.sourcePaths,
    required this.referenceIndex,
    required this.showOmissionCandidates,
    required this.autoExcludeOmissionCandidates,
    required this.outputFormatName,
    required this.storagePresetName,
    required this.initialSelection,
    required this.omissionCandidates,
  });

  final FocusMarkingAnalysisResult analysis;
  final List<String> sourcePaths;
  final int referenceIndex;
  final bool showOmissionCandidates;
  final bool autoExcludeOmissionCandidates;
  final String outputFormatName;
  final String storagePresetName;
  final List<bool> initialSelection;
  final List<bool> omissionCandidates;
}

Uint8List _reduceMaskForPreview(
  Uint8List source, {
  required int sourceWidth,
  required int sourceHeight,
  required int outputWidth,
  required int outputHeight,
}) {
  final Uint8List reduced = Uint8List(outputWidth * outputHeight);
  for (int y = 0; y < sourceHeight; y++) {
    final int outputY = y * outputHeight ~/ sourceHeight;
    final int sourceRow = y * sourceWidth;
    final int outputRow = outputY * outputWidth;
    for (int x = 0; x < sourceWidth; x++) {
      if (source[sourceRow + x] == 0) continue;
      final int outputX = x * outputWidth ~/ sourceWidth;
      reduced[outputRow + outputX] = 1;
    }
  }
  return reduced;
}

Future<void> writeFocusMarkingBackgroundResult({
  required String path,
  required FocusMarkingAnalysisResult analysis,
  required List<String> sourcePaths,
  required int referenceIndex,
  required bool showOmissionCandidates,
  required bool autoExcludeOmissionCandidates,
  required String outputFormatName,
  required String storagePresetName,
}) async {
  final File metadataFile = File(path);
  final Directory directory = metadataFile.parent;
  await directory.create(recursive: true);
  final HighPrecisionFocusMarking marking = analysis.marking;
  if (analysis.exactPreviews.length != marking.frameCount ||
      analysis.exactPreviews.isEmpty) {
    throw StateError('Focus preview count does not match the marking.');
  }
  final int previewWidth = analysis.exactPreviews.first.width;
  final int previewHeight = analysis.exactPreviews.first.height;
  if (analysis.exactPreviews.any(
    (FocusExactPreview preview) =>
        preview.width != previewWidth || preview.height != previewHeight,
  )) {
    throw StateError('Focus preview dimensions do not match.');
  }
  final FocusFrameSelectionState selection = applyOptionalAutoExclusion(
    marking: marking,
    autoExclude: autoExcludeOmissionCandidates,
  );
  final List<String> maskNames = <String>[];
  // These mask/preview blobs can be tens of MB each. writeAsBytes already
  // waits for the file handle to close; forcing fsync for every intermediate
  // blob creates unnecessary storage pressure while Android is also serving
  // the UI. The final metadata file below is still flushed only after every
  // blob write has completed, so it remains the commit marker for this result.
  for (int index = 0; index < marking.frameMasks.length; index++) {
    final String name = 'focus_marking_$index.mask.u8';
    final Uint8List reduced = _reduceMaskForPreview(
      marking.frameMasks[index],
      sourceWidth: marking.width,
      sourceHeight: marking.height,
      outputWidth: previewWidth,
      outputHeight: previewHeight,
    );
    await File('${directory.path}${Platform.pathSeparator}$name')
        .writeAsBytes(reduced);
    maskNames.add(name);
  }
  final List<Map<String, dynamic>> previews = <Map<String, dynamic>>[];
  for (int index = 0; index < analysis.exactPreviews.length; index++) {
    final FocusExactPreview preview = analysis.exactPreviews[index];
    final String name = 'focus_preview_$index.u8';
    await File('${directory.path}${Platform.pathSeparator}$name')
        .writeAsBytes(preview.luminance8);
    previews.add(<String, dynamic>{
      'file': name,
      'width': preview.width,
      'height': preview.height,
    });
  }
  final Map<String, dynamic> payload = <String, dynamic>{
    'sourcePaths': sourcePaths,
    'referenceIndex': referenceIndex,
    'showOmissionCandidates': showOmissionCandidates,
    'autoExcludeOmissionCandidates': autoExcludeOmissionCandidates,
    'outputFormatName': outputFormatName,
    'storagePresetName': storagePresetName,
    'marking': <String, dynamic>{
      // Review masks use the exact-preview coordinate system. Keeping every
      // full-resolution per-frame mask in the UI process can exceed a phone's
      // heap (e.g. 24 MP x 20 frames is ~480 MB for masks alone).
      'width': previewWidth,
      'height': previewHeight,
      'sourceWidth': marking.width,
      'sourceHeight': marking.height,
      'frameCount': marking.frameCount,
      'coverageFractions': marking.coverageFractions,
      'maskFiles': maskNames,
    },
    'previews': previews,
    'initialSelection': selection.selected,
    'omissionCandidates': selection.omissionCandidates,
  };
  await metadataFile.writeAsString(jsonEncode(payload), flush: true);
}

Future<FocusMarkingBackgroundResult> readFocusMarkingBackgroundResult(
  String path,
) async {
  final File metadataFile = File(path);
  final Object? decoded = jsonDecode(await metadataFile.readAsString());
  if (decoded is! Map<String, dynamic>) {
    throw StateError('Invalid focus marking background result.');
  }
  final Directory directory = metadataFile.parent;
  final Map<String, dynamic> markingMap =
      (decoded['marking'] as Map).cast<String, dynamic>();
  final int width = (markingMap['width'] as num).toInt();
  final int height = (markingMap['height'] as num).toInt();
  final int frameCount = (markingMap['frameCount'] as num).toInt();
  final int expectedPixels = width * height;
  final List<Uint8List> masks = <Uint8List>[];
  for (final Object? rawName in markingMap['maskFiles'] as List<dynamic>) {
    final Uint8List bytes = await File(
      '${directory.path}${Platform.pathSeparator}${rawName as String}',
    ).readAsBytes();
    if (bytes.length != expectedPixels) {
      throw StateError('Focus marking mask length mismatch.');
    }
    masks.add(bytes);
  }
  if (masks.length != frameCount) {
    throw StateError('Focus marking mask count mismatch.');
  }
  final List<double> fractions =
      (markingMap['coverageFractions'] as List<dynamic>)
          .cast<num>()
          .map((num value) => value.toDouble())
          .toList(growable: false);
  final HighPrecisionFocusMarking marking = HighPrecisionFocusMarking(
    width: width,
    height: height,
    frameCount: frameCount,
    confidence: Float32List(0),
    frameMasks: masks,
    coverageFractions: fractions,
  );
  final FocusFrameSelectionState legacySelection = applyOptionalAutoExclusion(
    marking: marking,
    autoExclude: decoded['autoExcludeOmissionCandidates'] as bool? ?? false,
  );
  final List<bool> initialSelection =
      (decoded['initialSelection'] as List<dynamic>?)?.cast<bool>() ??
          legacySelection.selected;
  final List<bool> omissionCandidates =
      (decoded['omissionCandidates'] as List<dynamic>?)?.cast<bool>() ??
          legacySelection.omissionCandidates;
  if (initialSelection.length != frameCount ||
      omissionCandidates.length != frameCount) {
    throw StateError('Focus selection metadata length mismatch.');
  }
  final List<FocusExactPreview> previews = <FocusExactPreview>[];
  for (final Object? rawPreview in decoded['previews'] as List<dynamic>) {
    final Map<String, dynamic> previewMap =
        (rawPreview as Map).cast<String, dynamic>();
    final int previewWidth = (previewMap['width'] as num).toInt();
    final int previewHeight = (previewMap['height'] as num).toInt();
    final Uint8List bytes = await File(
      '${directory.path}${Platform.pathSeparator}${previewMap['file'] as String}',
    ).readAsBytes();
    previews.add(FocusExactPreview(
      width: previewWidth,
      height: previewHeight,
      luminance8: bytes,
    ));
  }
  if (previews.length != frameCount) {
    throw StateError('Focus preview count mismatch.');
  }
  return FocusMarkingBackgroundResult(
    analysis: FocusMarkingAnalysisResult(
      marking: marking,
      exactPreviews: List<FocusExactPreview>.unmodifiable(previews),
    ),
    sourcePaths: (decoded['sourcePaths'] as List<dynamic>).cast<String>(),
    referenceIndex: (decoded['referenceIndex'] as num).toInt(),
    showOmissionCandidates: decoded['showOmissionCandidates'] as bool,
    autoExcludeOmissionCandidates:
        decoded['autoExcludeOmissionCandidates'] as bool,
    outputFormatName: decoded['outputFormatName'] as String,
    storagePresetName: decoded['storagePresetName'] as String,
    initialSelection: List<bool>.unmodifiable(initialSelection),
    omissionCandidates: List<bool>.unmodifiable(omissionCandidates),
  );
}
