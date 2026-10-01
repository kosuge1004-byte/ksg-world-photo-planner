import 'durable_focus_frame_cache.dart';
import '../raw/raw_decoder_contract.dart';
import '../image/cfa_pattern.dart';
import 'dart:io';

import '../image/file_backed_linear_rgb_tile_store.dart';
import '../image/linear_rgb_tile_store.dart';
import '../image/raw_saturation_mask.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'durable_decoded_frame_cache.dart';

/// Makes Milky Way decode durable, mirroring `DurableFocusFrameCache`'s
/// wrapping of the same underlying `DurableDecodedFrameCache` — this is the
/// gap `MilkyWayTileCombineCheckpointStore`'s own doc comment calls out as
/// separate and not covered by it: `runMilkyWayPipeline` previously had no
/// decode-restore hook at all, so every run always redecoded every frame
/// from scratch even when only the later combine stage needed to resume.
///
/// The one field `DurableDecodedFrameCache`'s own generic JSON descriptor
/// cannot hold cheaply is the per-frame saturation-influence mask: a packed
/// one-bit-per-pixel buffer (`RawSaturationMask.toPackedBytes()`), potentially
/// megabytes at full sensor resolution, so it gets its own sidecar file next
/// to the frame's existing `.f32`/`.json` files rather than being base64-
/// encoded into the JSON descriptor. The sidecar is written and flushed
/// *before* `DurableDecodedFrameCache.publish` commits its own receipt, so a
/// process death between the two leaves no receipt at all (this cache's
/// `restore` already refuses to trust a missing receipt) rather than a
/// receipt pointing at a sidecar that never finished.
final class DurableMilkyWayFrameCache {
  DurableMilkyWayFrameCache(this.cache);
  final DurableDecodedFrameCache cache;

  Future<LinearRgbTileStore> create(
          {required int index,
          required int width,
          required int height,
          required OverlappedTilePlan plan}) =>
      cache.create(index: index, width: width, height: height, plan: plan);

  String _saturationMaskPath(int index) =>
      '${cache.directory.path}${Platform.pathSeparator}frame_$index.satmask';

  Future<void> publish(
      int index, LinearRgbTileStore store, RawSaturationMask? saturationMask,
      {required RawFrameMetadata metadata,
      required CfaPattern cfaPattern}) async {
    final File maskFile = File(_saturationMaskPath(index));
    if (saturationMask == null) {
      // A previous attempt at this same index may have left a stale sidecar
      // (e.g. the frame used to be saturated and no longer is under a
      // different calibration). Never let a stale sidecar survive next to a
      // receipt that says there should not be one.
      if (await maskFile.exists()) await maskFile.delete();
    } else {
      await maskFile.writeAsBytes(saturationMask.toPackedBytes(), flush: true);
    }
    await cache.publish(index, store, descriptor: <String, Object?>{
      'hasSaturationMask': saturationMask != null,
      'metadata': DurableFocusFrameCache.encodeMetadata(metadata),
      'cfaPattern': cfaPattern.name,
      if (saturationMask != null)
        'saturationPixelCount': saturationMask.pixelCount,
      if (saturationMask != null)
        'saturatedCount': saturationMask.saturatedCount,
      if (saturationMask != null)
        'maskSha256': await DurableDecodedFrameCache.fileHash(maskFile),
    });
  }

  Future<DurableMilkyWayFrame?> restore(int index) async {
    final LinearRgbTileStore? store = await cache.restore(index);
    if (store == null) return null;
    try {
      final Map<String, dynamic>? descriptor =
          await cache.readDescriptor(index);
      if (descriptor == null) {
        throw StateError('Missing normalized descriptor for frame $index.');
      }
      RawSaturationMask? mask;
      if (descriptor['hasSaturationMask'] == true) {
        final int? pixelCount =
            (descriptor['saturationPixelCount'] as num?)?.toInt();
        final int? saturatedCount =
            (descriptor['saturatedCount'] as num?)?.toInt();
        if (pixelCount == null ||
            pixelCount != store.width * store.height ||
            saturatedCount == null) {
          throw StateError(
              'Invalid saturation-mask descriptor for frame $index.');
        }
        final File maskFile = File(_saturationMaskPath(index));
        final int expectedBytes = (pixelCount + 7) >> 3;
        if (!await maskFile.exists() ||
            await maskFile.length() != expectedBytes ||
            await DurableDecodedFrameCache.fileHash(maskFile) !=
                descriptor['maskSha256']) {
          throw StateError(
              'Missing/invalid saturation-mask sidecar for frame $index.');
        }
        mask = RawSaturationMask.takePackedBytes(
          pixelCount: pixelCount,
          packedBytes: await maskFile.readAsBytes(),
          saturatedCount: saturatedCount,
        );
      }
      final metadata = DurableFocusFrameCache.decodeMetadata(
          (descriptor['metadata'] as Map).cast<String, dynamic>());
      final cfa = CfaPattern.values.byName(descriptor['cfaPattern'] as String);
      return DurableMilkyWayFrame(store, mask, metadata, cfa);
    } on Object {
      // A corrupt/inconsistent record for this one frame must not take down
      // the rest of the run; the caller simply redecodes it, exactly like
      // DurableFocusFrameCache's own restore() does on the same kind of
      // failure.
      await (store as FileBackedLinearRgbTileStore).closeRetainingFile();
      return null;
    }
  }

  Future<void> release(LinearRgbTileStore store,
      {required bool discard}) async {
    if (!discard && store is FileBackedLinearRgbTileStore) {
      await store.closeRetainingFile();
    } else {
      await store.dispose();
    }
  }
}

final class DurableMilkyWayFrame {
  const DurableMilkyWayFrame(
      this.store, this.saturationMask, this.metadata, this.cfaPattern);
  final LinearRgbTileStore store;
  final RawSaturationMask? saturationMask;
  final RawFrameMetadata metadata;
  final CfaPattern cfaPattern;
}
