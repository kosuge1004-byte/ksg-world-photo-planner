import '../background/durable_focus_frame_cache.dart';
import 'dart:io';
import 'dart:typed_data';

import '../demosaic/demosaic_reconstructed_mosaic.dart';
import '../demosaic/demosaic_registry.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/raw_saturation_mask.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../io/raw_input_contract.dart';
import '../image/cfa_pattern.dart';
import '../raw/file_backed_raw_decode.dart';
import '../raw/raw_decoder_contract.dart';
import '../raw/raw_decoder_registry.dart';
import '../raw/raw_metadata_probe.dart';
import '../registration/affine_sampling_transform.dart';
import '../registration/luminance_plane.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'focus_frame_alignment_pipeline.dart';
import 'file_backed_focus_winner_map.dart';
import 'file_backed_focus_coverage_mask.dart';
import 'focus_correspondence_pipeline.dart';
import 'focus_blend_tile_checkpoint.dart';
import 'focus_map_regularizer.dart';
import 'focus_measure.dart';
import 'focus_measure_file_selection.dart';
import 'focus_photometric_normalization.dart';
import 'focus_stack_stage_checkpoint.dart';
import 'focus_tiled_blender.dart';

typedef FocusStackProgressCallback = void Function({
  required double fraction,
  required String stage,
  required int completedFrames,
  required int totalFrames,
});

final class FocusStackPipelineResult {
  FocusStackPipelineResult({
    required this.width,
    required this.height,
    required this.cameraRgbStore,
    required this.coverageMask,
    required this.referenceMetadata,
    required this.cfaPattern,
    required this.decoderId,
  });

  final int width;
  final int height;

  /// File-backed linear camera-RGB focus-stack result. Keeping the final RGB
  /// out of a full-resolution Float32List avoids roughly width*height*12 bytes
  /// of persistent resident memory while preserving the exact samples.
  final LinearRgbTileStore cameraRgbStore;

  /// File-backed 0/255 DNG validity mask. This removes the final
  /// width*height Uint8List from the long-lived focus result.
  final FileBackedFocusCoverageMask coverageMask;
  final RawFrameMetadata referenceMetadata;
  final CfaPattern cfaPattern;
  final String decoderId;

  Future<void> dispose({bool retainCheckpointFiles = false}) async {
    Object? firstError;
    StackTrace? firstStackTrace;
    try {
      if (retainCheckpointFiles &&
          cameraRgbStore is FileBackedLinearRgbTileStore) {
        await (cameraRgbStore as FileBackedLinearRgbTileStore)
            .closeRetainingFile();
      } else {
        await cameraRgbStore.dispose();
      }
    } catch (error, stackTrace) {
      firstError = error;
      firstStackTrace = stackTrace;
    }
    try {
      if (retainCheckpointFiles) {
        await coverageMask.closeRetainingFile();
      } else {
        await coverageMask.dispose();
      }
    } catch (error, stackTrace) {
      firstError ??= error;
      firstStackTrace ??= stackTrace;
    }
    if (firstError != null) {
      Error.throwWithStackTrace(firstError, firstStackTrace!);
    }
  }
}

final class FocusStackPipelineCancelled implements Exception {
  const FocusStackPipelineCancelled();
}

/// End-to-end focus-stack image pipeline through linear camera RGB.
///
/// This connects:
/// RAW decode -> production demosaic -> feature correspondence / focus-breathing
/// alignment -> coverage-aware focus measure -> winner selection -> ordinal
/// regularization -> halo-aware linear-RGB blending.
///
/// The first user-ordered frame is the geometric reference. The order itself
/// continues to carry the near-to-far or far-to-near focus-plane ordering
/// established by the input UI.
///
/// Work218 intentionally does not perform the final camera color transform or
/// DNG export. Those require one explicit output color contract for the whole
/// stack and are connected only after the image composite is stable.
Future<FocusStackPipelineResult> runFocusStackPipeline({
  required List<RawInputFile> inputs,
  required RawDecoderRegistry rawDecoderRegistry,
  required DemosaicRegistry demosaicRegistry,
  LinearRgbTileStoreFactory outputStoreFactory = _temporaryRgbStoreFactory,
  DurableFocusFrameCache? decodedFrameCache,
  int demosaicTileSize = 512,
  int alignmentTileSize = 512,
  int referenceIndex = 0,
  bool Function()? isCancelled,
  FocusStackProgressCallback? reportProgress,
  // Makes the alignment/focus-measure/winner-selection phase resumable
  // across a process death instead of always restarting it from the first
  // frame. Optional and off by default: every existing caller that does not
  // pass this gets byte-for-byte the same temp-directory behavior as before,
  // since none of the numerical alignment, focus-measure, selection, or
  // regularization logic below changes when it is present. The caller owns
  // deciding the checkpoint's `identity` (see FocusStackStageCheckpointStore)
  // and calling `clear()` once this pipeline's result is itself durably
  // committed further downstream.
  FocusStackStageCheckpointStore? stageCheckpoint,
  // Separately optional: makes only the final tile-by-tile blend resumable
  // (see FocusBlendTileCheckpointStore). Independent of stageCheckpoint —
  // either, both, or neither may be supplied — since resuming the blend and
  // resuming alignment/measure/winner-selection are unrelated durability
  // concerns with their own identity and their own failure modes.
  FocusBlendTileCheckpointStore? blendCheckpoint,
  // Work353: estimate and apply per-frame brightness/colour gains relative
  // to the reference before blending. Off by default (bit-identical).
  bool normalizeFrameExposure = false,
  // Work354: final composite method; depthMap keeps the blend bit-identical.
  FocusBlendMethod blendMethod = FocusBlendMethod.depthMap,
  void Function(String message)? log,
}) async {
  if (inputs.length < 2) {
    throw ArgumentError('Focus stack requires at least two RAW inputs.');
  }
  if (referenceIndex < 0 || referenceIndex >= inputs.length) {
    throw RangeError.index(referenceIndex, inputs, 'referenceIndex');
  }
  for (final RawInputFile input in inputs) {
    if (input.probe == null || !input.probe!.isAccepted) {
      throw ArgumentError(
          'Every focus-stack input must have an accepted RAW probe.');
    }
  }

  void checkCancelled() {
    if (isCancelled?.call() ?? false) {
      throw const FocusStackPipelineCancelled();
    }
  }

  final List<LinearRgbTileStore> decodedStores = <LinearRgbTileStore>[];
  final List<RawFrameMetadata> decodedMetadata = <RawFrameMetadata>[];
  final List<String> decodedDecoderIds = <String>[];
  RawFrameMetadata? referenceMetadata;
  CfaPattern? referenceCfaPattern;
  String? referenceDecoderId;
  int? referenceWidth;
  int? referenceHeight;
  Directory? measureDirectory;
  FileBackedFocusWinnerMap? winners;
  LinearRgbTileStore? finalResultStore;
  FileBackedFocusCoverageMask? finalCoverageMask;
  bool finalResultTransferred = false;
  try {
    for (int index = 0; index < inputs.length; index++) {
      checkCancelled();
      final RawInputFile input = inputs[index];
      final cached = await decodedFrameCache?.restore(index);
      if (cached != null) {
        decodedStores.add(cached.store);
        final descriptor = _FocusDecodedDescriptor(
            width: cached.store.width,
            height: cached.store.height,
            cfaPattern: cached.cfaPattern,
            metadata: cached.metadata,
            decoderId: cached.decoderId);
        _requireFocusOutputColorMetadata(descriptor.metadata);
        if (index == 0) {
          referenceMetadata = descriptor.metadata;
          referenceCfaPattern = descriptor.cfaPattern;
          referenceDecoderId = descriptor.decoderId;
          referenceWidth = descriptor.width;
          referenceHeight = descriptor.height;
        } else {
          _validateFocusDescriptorCompatibility(
              referenceWidth: referenceWidth!,
              referenceHeight: referenceHeight!,
              referenceCfaPattern: referenceCfaPattern!,
              referenceMetadata: referenceMetadata!,
              candidate: descriptor);
        }
        decodedMetadata.add(cached.metadata);
        decodedDecoderIds.add(cached.decoderId);
        reportProgress?.call(
            fraction: 0.45 * (index + 1) / inputs.length,
            stage: '保存済み現像を再利用',
            completedFrames: index + 1,
            totalFrames: inputs.length);
        continue;
      }

      final RawDecoder decoder =
          rawDecoderRegistry.requireDecoder(input.probe!.format);
      final RawFileBackedDecoder? fileBackedDecoder =
          decoder is RawFileBackedDecoder
              ? decoder as RawFileBackedDecoder
              : null;
      final RawMetadataProbeResult? probed = input.metadata;
      final RawFrameMetadata? probedFrameMetadata = probed?.metadata;
      final bool metadataGeometryAllowsStreaming = probed == null ||
          (probedFrameMetadata!.orientation == 1 &&
              probedFrameMetadata.activeArea.left == 0 &&
              probedFrameMetadata.activeArea.top == 0 &&
              probed.width == probedFrameMetadata.activeArea.width &&
              probed.height == probedFrameMetadata.activeArea.height);

      if (fileBackedDecoder != null &&
          fileBackedDecoder.supportsFileBackedDecode &&
          metadataGeometryAllowsStreaming) {
        FileBackedRawDecode? fileDecoded;
        try {
          fileDecoded = await FileBackedRawDecode.decode(
            decoder: fileBackedDecoder,
            request: RawDecodeRequest(probe: input.probe!),
          );
          final RawFrameMetadata metadata = mergeSameFrameRawMetadata(
            decoded: fileDecoded.result.metadata,
            probed: probedFrameMetadata,
          );
          final _FocusDecodedDescriptor descriptor = _FocusDecodedDescriptor(
            width: fileDecoded.result.width,
            height: fileDecoded.result.height,
            cfaPattern: fileDecoded.result.cfaPattern,
            metadata: metadata,
            decoderId: fileDecoded.result.decoderId,
          );
          _requireFocusOutputColorMetadata(descriptor.metadata);
          if (index == 0) {
            referenceMetadata = descriptor.metadata;
            referenceCfaPattern = descriptor.cfaPattern;
            referenceDecoderId = descriptor.decoderId;
            referenceWidth = descriptor.width;
            referenceHeight = descriptor.height;
          } else {
            _validateFocusDescriptorCompatibility(
              referenceWidth: referenceWidth!,
              referenceHeight: referenceHeight!,
              referenceCfaPattern: referenceCfaPattern!,
              referenceMetadata: referenceMetadata!,
              candidate: descriptor,
            );
          }
          final RawSaturationMask? saturationMask =
              await _scanFileBackedSaturationMask(
            store: fileDecoded.store,
            whiteLevel: metadata.whiteLevel,
            isCancelled: isCancelled,
          );
          final LinearRgbTileStore store = await demosaicFileBackedRawMosaic(
            mosaicStore: fileDecoded.store,
            saturationMask: saturationMask,
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
                stage: 'デモザイク',
                completedFrames: index,
                totalFrames: inputs.length,
              );
            },
          );
          decodedStores.add(store);
          decodedMetadata.add(descriptor.metadata);
          decodedDecoderIds.add(descriptor.decoderId);
          await decodedFrameCache?.publish(index, store, descriptor.metadata,
              descriptor.cfaPattern, descriptor.decoderId);
          continue;
        } on RawDecodeFailure catch (error) {
          if (error.code != RawDecodeErrorCode.unsupportedFormat) rethrow;
          // Geometry that still requires crop/orientation normalization keeps
          // the established in-memory path below.
        } finally {
          await fileDecoded?.dispose();
        }
      }

      final RawDecodeResult nativeDecoded = await decoder.decode(
        RawDecodeRequest(probe: input.probe!),
      );
      final RawDecodeResult decoded = RawDecodeResult(
        mosaic: nativeDecoded.mosaic,
        metadata: mergeSameFrameRawMetadata(
          decoded: nativeDecoded.metadata,
          probed: probedFrameMetadata,
        ),
        decoderId: nativeDecoded.decoderId,
        sampleLease: nativeDecoded.sampleLease,
      );
      _requireOutputColorMetadata(decoded);
      if (index == 0) {
        referenceMetadata = decoded.metadata;
        referenceCfaPattern = decoded.mosaic.cfaPattern;
        referenceDecoderId = decoded.decoderId;
        referenceWidth = decoded.mosaic.width;
        referenceHeight = decoded.mosaic.height;
      } else {
        _validateDecodedCompatibility(
          referenceWidth: referenceWidth!,
          referenceHeight: referenceHeight!,
          referenceCfaPattern: referenceCfaPattern!,
          referenceMetadata: referenceMetadata!,
          candidate: decoded,
        );
      }

      final LinearRgbTileStore store = await demosaicReconstructedMosaic(
        mosaic: decoded.mosaic,
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
            stage: 'デモザイク',
            completedFrames: index,
            totalFrames: inputs.length,
          );
        },
      );
      decodedStores.add(store);
      decodedMetadata.add(decoded.metadata);
      decodedDecoderIds.add(decoded.decoderId);
      await decodedFrameCache?.publish(index, store, decoded.metadata,
          decoded.mosaic.cfaPattern, decoded.decoderId);
    }

    // Structural validation guarantees the CFA pattern is identical across
    // every frame, while output color/WB metadata should come from the
    // user-selected reference exposure.
    referenceMetadata = decodedMetadata[referenceIndex];
    referenceDecoderId = decodedDecoderIds[referenceIndex];

    checkCancelled();
    final LinearRgbTileStore referenceStore = decodedStores[referenceIndex];
    LuminancePlane? referenceLuminance =
        await _readGreenLuminance(referenceStore);
    // With a checkpoint, `measureDirectory` IS the checkpoint's own durable
    // directory: every measure/winner file the phases below already write
    // lands there directly, with no separate durable copy step. Without one,
    // behavior is unchanged from before this checkpoint feature existed.
    measureDirectory = stageCheckpoint?.directory ??
        await Directory.systemTemp.createTemp('mobile-stack-final-focus-');
    final List<File?> measureSlots = List<File?>.filled(inputs.length, null);
    final File? restoredReferenceMeasure =
        await stageCheckpoint?.restoreMeasureFile(referenceIndex);
    if (restoredReferenceMeasure != null) {
      measureSlots[referenceIndex] = restoredReferenceMeasure;
    } else {
      final File referenceMeasureFile = File(
        '${measureDirectory.path}${Platform.pathSeparator}measure-$referenceIndex.f32',
      );
      await writeModifiedLaplacianFocusMeasureFile(
        luminance: referenceLuminance,
        supportRadius: 2,
        outputFile: referenceMeasureFile,
        // The reference frame is not geometrically resampled, so every source
        // pixel is valid. A null mask is exactly the all-valid contract and avoids
        // a full-resolution Uint8List (24 MB at 6000x4000).
        validMask: null,
        checkCancelled: checkCancelled,
      );
      await stageCheckpoint?.recordMeasureFile(
          referenceIndex, referenceMeasureFile);
      measureSlots[referenceIndex] = referenceMeasureFile;
    }
    final List<AffineSamplingTransform?> transformSlots =
        List<AffineSamplingTransform?>.filled(inputs.length, null);
    final List<FocusCorrespondenceResult?> correspondenceSlots =
        List<FocusCorrespondenceResult?>.filled(inputs.length, null);
    transformSlots[referenceIndex] = AffineSamplingTransform.identity();

    // Phase 1: determine every frame's correspondence while the full-resolution
    // reference green plane is resident. Each source green plane is released
    // immediately after its transform is fixed.
    for (int index = 0; index < decodedStores.length; index++) {
      if (index == referenceIndex) continue;
      checkCancelled();
      final AffineSamplingTransform? restoredTransform =
          await stageCheckpoint?.restoreTransform(index);
      if (restoredTransform != null) {
        // correspondenceSlots[index] intentionally stays null: Phase 2 below
        // must not need it for a frame whose transform was restored (see the
        // `transform:` fallback added to resampleFocusLuminanceForMarking).
        transformSlots[index] = restoredTransform;
        reportProgress?.call(
          fraction: 0.45 + 0.12 * (index + 1) / inputs.length,
          stage: '位置合わせ解析(再開)',
          completedFrames: index + 1,
          totalFrames: inputs.length,
        );
        continue;
      }
      LuminancePlane? sourceLuminance =
          await _readGreenLuminance(decodedStores[index]);
      final FocusCorrespondenceResult correspondence =
          estimateFocusAlignmentFromLuminance(
        reference: referenceLuminance,
        source: sourceLuminance,
      );
      correspondenceSlots[index] = correspondence;
      final AffineSamplingTransform transform =
          correspondence.alignment.toSamplingTransform();
      transformSlots[index] = transform;
      await stageCheckpoint?.recordTransform(index, transform);
      sourceLuminance = null;
      reportProgress?.call(
        fraction: 0.45 + 0.12 * (index + 1) / inputs.length,
        stage: '位置合わせ解析',
        completedFrames: index + 1,
        totalFrames: inputs.length,
      );
    }

    // No later operation needs the reference luminance itself. Releasing it
    // before allocating aligned green + coverage removes one full-resolution
    // Float32 plane from the focus-measure peak without changing any transform,
    // interpolation, focus metric, or final blending result.
    referenceLuminance = null;

    // Phase 2: resample and measure one non-reference frame at a time.
    for (int index = 0; index < decodedStores.length; index++) {
      if (index == referenceIndex) continue;
      checkCancelled();
      final File? restoredMeasure =
          await stageCheckpoint?.restoreMeasureFile(index);
      if (restoredMeasure != null) {
        measureSlots[index] = restoredMeasure;
        reportProgress?.call(
          fraction: 0.57 + 0.23 * (index + 1) / inputs.length,
          stage: '合焦度評価(再開)',
          completedFrames: index + 1,
          totalFrames: inputs.length,
        );
        continue;
      }
      // The transform always exists here even when Phase 1 restored it from
      // the checkpoint instead of computing a fresh correspondence (in which
      // case correspondenceSlots[index] is null and only the transform-based
      // path below is used; see resampleFocusLuminanceForMarking).
      final FocusCorrespondenceResult? correspondence =
          correspondenceSlots[index];
      final FocusAlignedLuminanceResult aligned =
          await resampleFocusLuminanceForMarking(
        sourceRgb: decodedStores[index],
        correspondence: correspondence,
        transform: correspondence == null ? transformSlots[index] : null,
        tileSize: alignmentTileSize,
        isCancelled: isCancelled,
      );
      final File measureFile = File(
        '${measureDirectory.path}${Platform.pathSeparator}measure-$index.f32',
      );
      await writeModifiedLaplacianFocusMeasureFile(
        luminance: aligned.luminance,
        supportRadius: 2,
        outputFile: measureFile,
        validMask: aligned.coverage,
        checkCancelled: checkCancelled,
      );
      await stageCheckpoint?.recordMeasureFile(index, measureFile);
      measureSlots[index] = measureFile;
      reportProgress?.call(
        fraction: 0.57 + 0.23 * (index + 1) / inputs.length,
        stage: '合焦度評価',
        completedFrames: index + 1,
        totalFrames: inputs.length,
      );
    }

    checkCancelled();
    final List<File> measureFiles = <File>[
      for (final File? file in measureSlots) file!,
    ];
    final List<AffineSamplingTransform> samplingTransforms =
        transformSlots.cast<AffineSamplingTransform>().toList(growable: false);
    final FileBackedFocusWinnerMap? restoredWinners =
        await stageCheckpoint?.restoreWinners(
      width: referenceStore.width,
      height: referenceStore.height,
    );
    if (restoredWinners != null) {
      winners = restoredWinners;
      reportProgress?.call(
        fraction: 0.88,
        stage: 'フォーカスマップ正則化(再開)',
        completedFrames: inputs.length,
        totalFrames: inputs.length,
      );
    } else {
      final FileBackedFocusWinnerMap selected =
          await selectAndRefineFocusWinnersToFiles(
        width: referenceStore.width,
        height: referenceStore.height,
        measureFiles: measureFiles,
        temporaryDirectory: measureDirectory,
        checkCancelled: checkCancelled,
      );
      final FileBackedFocusWinnerMap regularizedWinners =
          await regularizeFileBackedFocusWinnerMapTwoPass(
        selected,
        temporaryDirectory: measureDirectory,
        checkCancelled: checkCancelled,
      );
      await selected.dispose();
      winners = regularizedWinners;
      await stageCheckpoint?.recordWinners(regularizedWinners);
      reportProgress?.call(
        fraction: 0.88,
        stage: 'フォーカスマップ正則化',
        completedFrames: inputs.length,
        totalFrames: inputs.length,
      );
    }

    final OverlappedTilePlan finalPlan = OverlappedTilePlan.create(
      imageWidth: referenceStore.width,
      imageHeight: referenceStore.height,
      tileSize: alignmentTileSize,
      overlap: 0,
    );
    // With blendCheckpoint, the blend function creates/resumes its own
    // durable output store instead of using a fresh temporary one; only
    // create/track finalRgbStore here in the unchanged, no-checkpoint path.
    final LinearRgbTileStore? finalRgbStore = blendCheckpoint != null
        ? null
        : await _temporaryRgbStoreFactory(
            width: referenceStore.width,
            height: referenceStore.height,
            plan: finalPlan,
          );
    finalResultStore = finalRgbStore;
    List<FocusFrameGain>? frameGains;
    if (normalizeFrameExposure) {
      frameGains = await estimateFocusFrameGains(
        stores: decodedStores,
        samplingTransforms: samplingTransforms,
        isCancelled: isCancelled,
      );
      for (int frame = 0; frame < frameGains.length; frame++) {
        final FocusFrameGain gain = frameGains[frame];
        log?.call(
          'focus photometric gain frame=$frame applied=${gain.applied} '
          'r=${gain.r} g=${gain.g} b=${gain.b}',
        );
      }
    }
    final FocusFileBackedStoredBlendResult blend =
        await blendRegisteredFocusStoresFromFileBackedWinnersAndCoverageToStore(
      stores: decodedStores,
      samplingTransforms: samplingTransforms,
      winners: winners,
      outputStore: finalRgbStore,
      stageCheckpoint: blendCheckpoint,
      tileSize: alignmentTileSize,
      isCancelled: isCancelled,
      frameGains: frameGains,
      blendMethod: blendMethod,
      onPyramidTileCompleted: (int done, int total) {
        reportProgress?.call(
          fraction: 0.88 + 0.11 * done / total,
          stage: '深度合成（ピラミッド）',
          completedFrames: inputs.length,
          totalFrames: inputs.length,
        );
      },
    );
    // blendCheckpoint's resumed/created store is only known once the call
    // above returns; track it from here on so the outer cleanup below
    // (finalResultStore) covers it too on a non-success exit.
    finalResultStore ??= blend.rgbStore;
    finalCoverageMask = blend.coverageMask;
    if (stageCheckpoint == null) await winners.dispose();
    winners = null;
    checkCancelled();
    reportProgress?.call(
      fraction: 1,
      stage: '深度合成完了',
      completedFrames: inputs.length,
      totalFrames: inputs.length,
    );

    final FocusStackPipelineResult result = FocusStackPipelineResult(
      width: blend.width,
      height: blend.height,
      cameraRgbStore: blend.rgbStore,
      coverageMask: blend.coverageMask,
      referenceMetadata: referenceMetadata,
      cfaPattern: referenceCfaPattern!,
      decoderId: referenceDecoderId,
    );
    finalResultTransferred = true;
    finalCoverageMask = null;
    return result;
  } finally {
    final LinearRgbTileStore? finalStore = finalResultStore;
    try {
      if (!finalResultTransferred && finalStore != null) {
        if (blendCheckpoint != null &&
            finalStore is FileBackedLinearRgbTileStore) {
          await finalStore.closeRetainingFile();
        } else {
          await finalStore.dispose();
        }
      }
      if (!finalResultTransferred) {
        if (blendCheckpoint != null) {
          await finalCoverageMask?.closeRetainingFile();
        } else {
          await finalCoverageMask?.dispose();
        }
        finalCoverageMask = null;
      }
    } finally {
      try {
        // On failure/cancellation with a checkpoint active, `winners` (when
        // still non-null here) is the durable regularized winner map this
        // checkpoint already recorded via recordWinners(). Deleting it here
        // would erase exactly the work a resumed attempt should be able to
        // skip, so it is left in place; only the success path (where
        // `winners` was already nulled out right after the blend call
        // above) or the no-checkpoint path dispose it here.
        if (stageCheckpoint == null) {
          await winners?.dispose();
        }
        winners = null;
        final Directory? scores = measureDirectory;
        if (stageCheckpoint == null) {
          // Unchanged pre-existing behavior: these always lived only in
          // Directory.systemTemp, so they are always discarded here
          // regardless of success, failure, or cancellation.
          if (scores != null && await scores.exists()) {
            await scores.delete(recursive: true);
          }
        } else if (finalResultTransferred) {
          // The blend succeeded and the result has been handed to the
          // caller: the alignment/measure/winner checkpoint has done its
          // job and nothing will ever resume from it again. On failure or
          // cancellation this is deliberately skipped, so a later retry with
          // the same identity can resume instead of starting over.
          /* Retained until the worker publishes the final output receipt. */
        }
      } finally {
        // Decoded stores are the largest temporary resources. Their cleanup
        // must run even if an earlier temp-file cleanup operation fails, and
        // one disposal failure must not strand the remaining stores.
        await _disposeDecodedRgbStoresBestEffort(decodedStores.reversed,
            cache: decodedFrameCache, discard: isCancelled?.call() ?? false);
      }
    }
  }
}

Future<void> _disposeDecodedRgbStoresBestEffort(
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

final class _FocusDecodedDescriptor {
  const _FocusDecodedDescriptor({
    required this.width,
    required this.height,
    required this.cfaPattern,
    required this.metadata,
    required this.decoderId,
  });
  final int width;
  final int height;
  final CfaPattern cfaPattern;
  final RawFrameMetadata metadata;
  final String decoderId;
}

void _requireFocusOutputColorMetadata(RawFrameMetadata metadata) {
  if (metadata.d65XyzToCamera == null) {
    throw ArgumentError(
      'Focus-stack Linear DNG output requires D65 camera color matrix metadata.',
    );
  }
  if (metadata.cameraWhiteBalance == null) {
    throw ArgumentError(
      'Focus-stack Linear DNG output requires camera white-balance metadata.',
    );
  }
}

void _validateFocusDescriptorCompatibility({
  required int referenceWidth,
  required int referenceHeight,
  required CfaPattern referenceCfaPattern,
  required RawFrameMetadata referenceMetadata,
  required _FocusDecodedDescriptor candidate,
}) {
  if (candidate.width != referenceWidth ||
      candidate.height != referenceHeight ||
      candidate.cfaPattern != referenceCfaPattern ||
      candidate.metadata.format != referenceMetadata.format ||
      candidate.metadata.orientation != referenceMetadata.orientation) {
    throw ArgumentError(
      'Decoded focus-stack RAW frames are not structurally compatible.',
    );
  }
  final RawActiveArea a = referenceMetadata.activeArea;
  final RawActiveArea b = candidate.metadata.activeArea;
  if (a.left != b.left ||
      a.top != b.top ||
      a.width != b.width ||
      a.height != b.height) {
    throw ArgumentError(
      'Decoded focus-stack RAW ActiveArea differs from reference.',
    );
  }
  final List<double>? referenceMatrix = referenceMetadata.d65XyzToCamera;
  final List<double>? candidateMatrix = candidate.metadata.d65XyzToCamera;
  if (referenceMatrix == null || candidateMatrix == null) {
    throw ArgumentError(
      'Focus-stack Linear DNG output requires D65 camera color matrices '
      'for every selected RAW.',
    );
  }
  for (int index = 0; index < 9; index++) {
    if ((referenceMatrix[index] - candidateMatrix[index]).abs() > 1e-5) {
      throw ArgumentError(
        'Selected focus-stack RAW frames use incompatible camera color matrices.',
      );
    }
  }
  if (referenceMetadata.cameraWhiteBalance == null ||
      candidate.metadata.cameraWhiteBalance == null) {
    throw ArgumentError(
      'Focus-stack Linear DNG output requires camera white-balance metadata '
      'for every selected RAW.',
    );
  }
}

Future<RawSaturationMask?> _scanFileBackedSaturationMask({
  required FileBackedLinearRawMosaicStore store,
  required double whiteLevel,
  required bool Function()? isCancelled,
  int rowChunk = 64,
}) async {
  final int pixelCount = store.width * store.height;
  final Uint8List packed = Uint8List((pixelCount + 7) >> 3);
  int saturatedCount = 0;
  for (int y = 0; y < store.height; y += rowChunk) {
    if (isCancelled?.call() ?? false) {
      throw const FocusStackPipelineCancelled();
    }
    final int rows =
        (store.height - y) < rowChunk ? store.height - y : rowChunk;
    final Float32List samples = await store.readRegion(
      x: 0,
      y: y,
      width: store.width,
      height: rows,
    );
    for (int local = 0; local < samples.length; local++) {
      final double value = samples[local];
      if (!value.isFinite) {
        throw StateError(
          'Focus-stack streamed RAW contains a non-finite sample.',
        );
      }
      if (value >= whiteLevel) {
        final int pixel = y * store.width + local;
        packed[pixel >> 3] |= 1 << (pixel & 7);
        saturatedCount++;
      }
    }
  }
  if (saturatedCount == 0) return null;
  return RawSaturationMask.takePackedBytes(
    pixelCount: pixelCount,
    packedBytes: packed,
    saturatedCount: saturatedCount,
  );
}

void _requireOutputColorMetadata(RawDecodeResult frame) {
  if (frame.metadata.d65XyzToCamera == null) {
    throw ArgumentError(
      'Focus-stack Linear DNG output requires D65 camera color matrix metadata.',
    );
  }
  if (frame.metadata.cameraWhiteBalance == null) {
    throw ArgumentError(
      'Focus-stack Linear DNG output requires camera white-balance metadata.',
    );
  }
}

void _validateDecodedCompatibility({
  required int referenceWidth,
  required int referenceHeight,
  required CfaPattern referenceCfaPattern,
  required RawFrameMetadata referenceMetadata,
  required RawDecodeResult candidate,
}) {
  if (candidate.mosaic.width != referenceWidth ||
      candidate.mosaic.height != referenceHeight ||
      candidate.mosaic.cfaPattern != referenceCfaPattern ||
      candidate.metadata.format != referenceMetadata.format ||
      candidate.metadata.orientation != referenceMetadata.orientation) {
    throw ArgumentError(
      'Decoded focus-stack RAW frames are not structurally compatible.',
    );
  }
  final RawActiveArea a = referenceMetadata.activeArea;
  final RawActiveArea b = candidate.metadata.activeArea;
  if (a.left != b.left ||
      a.top != b.top ||
      a.width != b.width ||
      a.height != b.height) {
    throw ArgumentError(
      'Decoded focus-stack RAW ActiveArea differs from reference.',
    );
  }

  final List<double>? referenceMatrix = referenceMetadata.d65XyzToCamera;
  final List<double>? candidateMatrix = candidate.metadata.d65XyzToCamera;
  if (referenceMatrix == null || candidateMatrix == null) {
    throw ArgumentError(
      'Focus-stack Linear DNG output requires D65 camera color matrices '
      'for every selected RAW.',
    );
  }
  for (int index = 0; index < 9; index++) {
    if ((referenceMatrix[index] - candidateMatrix[index]).abs() > 1e-5) {
      throw ArgumentError(
        'Selected focus-stack RAW frames use incompatible camera color matrices.',
      );
    }
  }

  if (referenceMetadata.cameraWhiteBalance == null ||
      candidate.metadata.cameraWhiteBalance == null) {
    throw ArgumentError(
      'Focus-stack Linear DNG output requires camera white-balance metadata '
      'for every selected RAW.',
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
