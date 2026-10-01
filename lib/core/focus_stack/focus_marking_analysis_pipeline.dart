import '../background/durable_focus_frame_cache.dart';
import 'dart:io';
import 'dart:typed_data';

import '../demosaic/demosaic_reconstructed_mosaic.dart';
import '../demosaic/demosaic_registry.dart';
import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../io/raw_input_contract.dart';
import '../raw/raw_decoder_contract.dart';
import '../raw/raw_decoder_registry.dart';
import '../raw/raw_format.dart';
import '../registration/luminance_plane.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'focus_frame_alignment_pipeline.dart';
import 'focus_correspondence_pipeline.dart';
import 'high_precision_focus_marking.dart';
import 'focus_exact_preview.dart';

typedef FocusMarkingProgressCallback = void Function({
  required double fraction,
  required String stage,
  required int completedFrames,
  required int totalFrames,
});

final class FocusMarkingAnalysisResult {
  const FocusMarkingAnalysisResult({
    required this.marking,
    required this.exactPreviews,
  });

  final HighPrecisionFocusMarking marking;
  final List<FocusExactPreview> exactPreviews;
}

final class FocusMarkingAnalysisCancelled implements Exception {
  const FocusMarkingAnalysisCancelled();
}

/// Runs only the image stages needed for pre-composite high-precision marking.
///
/// RAW decode -> production demosaic -> reference materialization ->
/// scaled-similarity alignment of other frames -> multi-scale focus marking.
///
/// This analysis deliberately stops before focus winner regularization and
/// blending. The user reviews the marking, then the confirmed subset is sent
/// to the normal focus-stack pipeline.
Future<FocusMarkingAnalysisResult> analyzeFocusMarking({
  required List<RawInputFile> inputs,
  required RawDecoderRegistry rawDecoderRegistry,
  required DemosaicRegistry demosaicRegistry,
  LinearRgbTileStoreFactory outputStoreFactory = _temporaryRgbStoreFactory,
  DurableFocusFrameCache? decodedFrameCache,
  int demosaicTileSize = 512,
  int alignmentTileSize = 512,
  int referenceIndex = 0,
  bool Function()? isCancelled,
  FocusMarkingProgressCallback? reportProgress,
}) async {
  if (inputs.length < 2) {
    throw ArgumentError('Focus marking requires at least two RAW inputs.');
  }
  if (referenceIndex < 0 || referenceIndex >= inputs.length) {
    throw RangeError.index(referenceIndex, inputs, 'referenceIndex');
  }
  for (final RawInputFile input in inputs) {
    if (input.probe == null || !input.probe!.isAccepted) {
      throw ArgumentError(
        'Every focus-marking input must have an accepted RAW probe.',
      );
    }
  }

  void checkCancelled() {
    if (isCancelled?.call() ?? false) {
      throw const FocusMarkingAnalysisCancelled();
    }
  }

  final List<LinearRgbTileStore> stores = <LinearRgbTileStore>[];
  _DecodedFocusStructure? referenceStructure;
  Directory? scoreDirectory;
  try {
    for (int index = 0; index < inputs.length; index++) {
      checkCancelled();
      final cached = await decodedFrameCache?.restore(index);
      if (cached != null) {
        final structure = _DecodedFocusStructure(
            width: cached.store.width,
            height: cached.store.height,
            cfaPattern: cached.cfaPattern,
            format: cached.metadata.format,
            orientation: cached.metadata.orientation,
            activeAreaLeft: cached.metadata.activeArea.left,
            activeAreaTop: cached.metadata.activeArea.top,
            activeAreaWidth: cached.metadata.activeArea.width,
            activeAreaHeight: cached.metadata.activeArea.height);
        if (referenceStructure == null) {
          referenceStructure = structure;
        } else if (referenceStructure.width != structure.width ||
            referenceStructure.height != structure.height ||
            referenceStructure.cfaPattern != structure.cfaPattern ||
            referenceStructure.format != structure.format ||
            referenceStructure.orientation != structure.orientation ||
            referenceStructure.activeAreaLeft != structure.activeAreaLeft ||
            referenceStructure.activeAreaTop != structure.activeAreaTop ||
            referenceStructure.activeAreaWidth != structure.activeAreaWidth ||
            referenceStructure.activeAreaHeight != structure.activeAreaHeight) {
          await decodedFrameCache!.release(cached.store, discard: false);
          throw ArgumentError(
              'Saved focus-marking geometry differs from reference');
        }
        stores.add(cached.store);
        reportProgress?.call(
            fraction: 0.45 * (index + 1) / inputs.length,
            stage: '保存済み現像を再利用',
            completedFrames: index + 1,
            totalFrames: inputs.length);
        continue;
      }
      final RawDecoder decoder =
          rawDecoderRegistry.requireDecoder(inputs[index].probe!.format);
      final RawDecodeResult frame = await decoder.decode(
        RawDecodeRequest(probe: inputs[index].probe!),
      );
      if (referenceStructure == null) {
        referenceStructure = _DecodedFocusStructure.fromFrame(frame);
      } else {
        _validateCompatibility(referenceStructure, frame);
      }

      final LinearRgbTileStore store = await demosaicReconstructedMosaic(
        mosaic: frame.mosaic,
        demosaicRegistry: demosaicRegistry,
        outputStoreFactory: decodedFrameCache == null
            ? outputStoreFactory
            : ({required width, required height, required plan}) =>
                decodedFrameCache.create(index,
                    width: width, height: height, plan: plan),
        tileSize: demosaicTileSize,
        isCancelled: isCancelled,
        reportProgress: (double p) {
          reportProgress?.call(
            fraction: 0.45 * (index + p) / inputs.length,
            stage: '合焦解析用デモザイク',
            completedFrames: index,
            totalFrames: inputs.length,
          );
        },
      );
      stores.add(store);
      await decodedFrameCache?.publish(index, store, frame.metadata,
          frame.mosaic.cfaPattern, frame.decoderId);
    }

    final LinearRgbTileStore referenceStore = stores[referenceIndex];
    final LuminancePlane referenceLuminance =
        await _readGreenLuminance(referenceStore);
    scoreDirectory =
        await Directory.systemTemp.createTemp('mobile_stack_focus_scores_');
    final List<File?> scoreSlots = List<File?>.filled(inputs.length, null);
    final List<FocusExactPreview?> previewSlots =
        List<FocusExactPreview?>.filled(inputs.length, null);
    final List<File?> maskFiles = List<File?>.filled(inputs.length, null);
    previewSlots[referenceIndex] = buildExactFocusPreview(referenceLuminance);
    // The unwarped reference is valid everywhere. Null is the exact all-valid
    // contract and avoids one full-resolution Uint8List.
    final File referenceScoreFile = File(
      '${scoreDirectory.path}${Platform.pathSeparator}frame-$referenceIndex.f32',
    );
    await writeHighPrecisionFocusFrameScoreFileBacked(
      alignedLuminance: referenceLuminance,
      outputFile: referenceScoreFile,
      validMask: null,
      checkCancelled: checkCancelled,
    );
    scoreSlots[referenceIndex] = referenceScoreFile;

    for (int index = 0; index < stores.length; index++) {
      if (index == referenceIndex) continue;
      checkCancelled();
      LuminancePlane? sourceLuminance =
          await _readGreenLuminance(stores[index]);
      final FocusCorrespondenceResult correspondence =
          estimateFocusAlignmentFromLuminance(
        reference: referenceLuminance,
        source: sourceLuminance,
      );
      // The transform is fixed after correspondence estimation. Drop the
      // 6000x4000 Float32 source plane before allocating aligned luminance.
      sourceLuminance = null;
      final FocusAlignedLuminanceResult aligned =
          await resampleFocusLuminanceForMarking(
        sourceRgb: stores[index],
        correspondence: correspondence,
        tileSize: alignmentTileSize,
        isCancelled: isCancelled,
      );
      previewSlots[index] = buildExactFocusPreview(aligned.luminance);
      final File scoreFile = File(
        '${scoreDirectory.path}${Platform.pathSeparator}frame-$index.f32',
      );
      await writeHighPrecisionFocusFrameScoreFileBacked(
        alignedLuminance: aligned.luminance,
        outputFile: scoreFile,
        validMask: aligned.coverage,
        checkCancelled: checkCancelled,
      );
      scoreSlots[index] = scoreFile;
      final File maskFile = File(
        '${scoreDirectory.path}${Platform.pathSeparator}frame-$index.mask.u8',
      );
      final RandomAccessFile maskWriter =
          await maskFile.open(mode: FileMode.write);
      try {
        await maskWriter.writeFrom(aligned.coverage);
        await maskWriter.flush();
      } finally {
        await maskWriter.close();
      }
      maskFiles[index] = maskFile;
      reportProgress?.call(
        fraction: 0.45 + 0.40 * index / (inputs.length - 1),
        stage: '位置合わせ・合焦解析',
        completedFrames: index + 1,
        totalFrames: inputs.length,
      );
    }

    checkCancelled();
    final List<File> combinedScoreFiles = <File>[
      for (final File? file in scoreSlots) file!,
    ];
    final List<FocusExactPreview> exactPreviews = <FocusExactPreview>[
      for (final FocusExactPreview? preview in previewSlots) preview!,
    ];
    final HighPrecisionFocusMarking marking =
        await buildHighPrecisionFocusMarkingFromScoreFiles(
      width: referenceStore.width,
      height: referenceStore.height,
      combinedScoreFiles: combinedScoreFiles,
      validMaskFiles: maskFiles,
      retainConfidence: false,
      checkCancelled: checkCancelled,
    );
    reportProgress?.call(
      fraction: 1,
      stage: '合焦位置解析完了',
      completedFrames: inputs.length,
      totalFrames: inputs.length,
    );
    return FocusMarkingAnalysisResult(
      marking: marking,
      exactPreviews: List<FocusExactPreview>.unmodifiable(exactPreviews),
    );
  } finally {
    // Store disposal must still run if score cleanup itself fails. A failed
    // temp-directory delete must never strand the much larger RGB stores.
    try {
      if (scoreDirectory != null && await scoreDirectory.exists()) {
        await scoreDirectory.delete(recursive: true);
      }
    } finally {
      await _disposeFocusRgbStoresBestEffort(stores.reversed,
          cache: decodedFrameCache, discard: isCancelled?.call() ?? false);
    }
  }
}

Future<void> _disposeFocusRgbStoresBestEffort(
    Iterable<LinearRgbTileStore> stores,
    {DurableFocusFrameCache? cache,
    bool discard = false}) async {
  Object? firstError;
  StackTrace? firstStackTrace;
  for (final LinearRgbTileStore store in stores) {
    try {
      if (cache != null) {
        await cache.release(store, discard: discard);
      } else {
        await store.dispose();
      }
    } catch (error, stackTrace) {
      firstError ??= error;
      firstStackTrace ??= stackTrace;
    }
  }
  if (firstError != null) {
    Error.throwWithStackTrace(firstError, firstStackTrace!);
  }
}

Future<LinearRgbTileStore> _temporaryRgbStoreFactory({
  required int width,
  required int height,
  required OverlappedTilePlan plan,
}) =>
    FileBackedLinearRgbTileStore.createTemporary(
      width: width,
      height: height,
      plan: plan,
    );

final class _DecodedFocusStructure {
  const _DecodedFocusStructure({
    required this.width,
    required this.height,
    required this.cfaPattern,
    required this.format,
    required this.orientation,
    required this.activeAreaLeft,
    required this.activeAreaTop,
    required this.activeAreaWidth,
    required this.activeAreaHeight,
  });

  factory _DecodedFocusStructure.fromFrame(RawDecodeResult frame) {
    final RawActiveArea activeArea = frame.metadata.activeArea;
    return _DecodedFocusStructure(
      width: frame.mosaic.width,
      height: frame.mosaic.height,
      cfaPattern: frame.mosaic.cfaPattern,
      format: frame.metadata.format,
      orientation: frame.metadata.orientation,
      activeAreaLeft: activeArea.left,
      activeAreaTop: activeArea.top,
      activeAreaWidth: activeArea.width,
      activeAreaHeight: activeArea.height,
    );
  }

  final int width;
  final int height;
  final CfaPattern cfaPattern;
  final RawFormat format;
  final int orientation;
  final int activeAreaLeft;
  final int activeAreaTop;
  final int activeAreaWidth;
  final int activeAreaHeight;
}

void _validateCompatibility(
  _DecodedFocusStructure reference,
  RawDecodeResult candidate,
) {
  if (candidate.mosaic.width != reference.width ||
      candidate.mosaic.height != reference.height ||
      candidate.mosaic.cfaPattern != reference.cfaPattern ||
      candidate.metadata.format != reference.format ||
      candidate.metadata.orientation != reference.orientation) {
    throw ArgumentError(
      'Decoded focus-marking RAW frames are not structurally compatible.',
    );
  }
  final RawActiveArea b = candidate.metadata.activeArea;
  if (reference.activeAreaLeft != b.left ||
      reference.activeAreaTop != b.top ||
      reference.activeAreaWidth != b.width ||
      reference.activeAreaHeight != b.height) {
    throw ArgumentError(
      'Decoded focus-marking RAW ActiveArea differs from reference.',
    );
  }
}

Future<LuminancePlane> _readGreenLuminance(
  LinearRgbTileStore store,
) async {
  final Float32List green = Float32List(store.width * store.height);
  const int rowsPerRead = 64;
  for (int y = 0; y < store.height; y += rowsPerRead) {
    final int rowCount =
        y + rowsPerRead <= store.height ? rowsPerRead : store.height - y;
    final LinearRgbTile tile = await store.readRegion(
      x: 0,
      y: y,
      width: store.width,
      height: rowCount,
    );
    final int outputStart = y * store.width;
    final int tilePixels = store.width * rowCount;
    for (int pixel = 0; pixel < tilePixels; pixel++) {
      green[outputStart + pixel] = tile.interleavedRgb[pixel * 3 + 1];
    }
  }
  return LuminancePlane(
    width: store.width,
    height: store.height,
    samples: green,
  );
}
