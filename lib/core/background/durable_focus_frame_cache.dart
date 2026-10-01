import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../image/linear_rgb_tile_store.dart';
import '../raw/raw_decoder_contract.dart';
import '../raw/raw_format.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'durable_decoded_frame_cache.dart';

final class DurableFocusFrame {
  const DurableFocusFrame(
      this.store, this.metadata, this.cfaPattern, this.decoderId);
  final LinearRgbTileStore store;
  final RawFrameMetadata metadata;
  final CfaPattern cfaPattern;
  final String decoderId;
}

/// Saves the actual normalized metadata together with the exact decoded RGB.
/// Probed sensor geometry cannot substitute for decoded crop/CFA/orientation.
final class DurableFocusFrameCache {
  DurableFocusFrameCache(this.cache, {this.onCommitted});
  final DurableDecodedFrameCache cache;
  final Future<void> Function(int count)? onCommitted;
  int committedFrames = 0;
  Future<LinearRgbTileStore> create(int index,
          {required int width,
          required int height,
          required OverlappedTilePlan plan}) =>
      cache.create(index: index, width: width, height: height, plan: plan);

  Future<void> publish(
      int index,
      LinearRgbTileStore store,
      RawFrameMetadata metadata,
      CfaPattern cfaPattern,
      String decoderId) async {
    await cache.publish(index, store, descriptor: {
      'metadata': encodeMetadata(metadata),
      'cfaPattern': cfaPattern.name,
      'decoderId': decoderId
    });
    committedFrames++;
    await onCommitted?.call(committedFrames);
  }

  Future<DurableFocusFrame?> restore(int index) async {
    final store = await cache.restore(index);
    if (store == null) return null;
    try {
      final descriptor = await cache.readDescriptor(index);
      if (descriptor == null) throw StateError('Missing normalized metadata');
      final metadata = decodeMetadata(
          (descriptor['metadata'] as Map).cast<String, dynamic>());
      final cfa = CfaPattern.values.byName(descriptor['cfaPattern'] as String);
      if (!metadata.activeArea.fitsInside(store.width, store.height) ||
          metadata.orientation != 1) {
        throw StateError('Invalid normalized geometry');
      }
      final record = DurableFocusFrame(
          store, metadata, cfa, descriptor['decoderId'] as String);
      committedFrames++;
      await onCommitted?.call(committedFrames);
      return record;
    } on Object {
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

  static Map<String, Object?> encodeMetadata(RawFrameMetadata m) => {
        'format': m.format.name,
        'activeArea': {
          'left': m.activeArea.left,
          'top': m.activeArea.top,
          'width': m.activeArea.width,
          'height': m.activeArea.height
        },
        'orientation': m.orientation,
        'blackLevels': m.blackLevels,
        'whiteLevel': m.whiteLevel,
        'cameraWhiteBalance': m.cameraWhiteBalance,
        'd65XyzToCamera': m.d65XyzToCamera,
        'baselineExposure': m.baselineExposure,
        'baselineExposureOffset': m.baselineExposureOffset,
        'profileDynamicRange': m.profileDynamicRange,
        'profileHintMaxOutputValue': m.profileHintMaxOutputValue,
        'profileToneCurve': m.profileToneCurve,
        'linearizationTable': m.linearizationTable,
        'blackLevelDeltaH': m.blackLevelDeltaH,
        'blackLevelDeltaV': m.blackLevelDeltaV,
        'profileHueSatMap': m.profileHueSatMap == null
            ? null
            : {
                'h': m.profileHueSatMap!.hueDivisions,
                's': m.profileHueSatMap!.saturationDivisions,
                'v': m.profileHueSatMap!.valueDivisions,
                'encoding': m.profileHueSatMap!.encoding,
                'deltas': m.profileHueSatMap!.deltas
              },
        'profileLookTable': m.profileLookTable == null
            ? null
            : {
                'h': m.profileLookTable!.hueDivisions,
                's': m.profileLookTable!.saturationDivisions,
                'v': m.profileLookTable!.valueDivisions,
                'encoding': m.profileLookTable!.encoding,
                'deltas': m.profileLookTable!.deltas
              },
      };

  static RawFrameMetadata decodeMetadata(Map<String, dynamic> m) {
    List<double>? list(String name) =>
        (m[name] as List?)?.map((x) => (x as num).toDouble()).toList();
    final a = m['activeArea'] as Map;
    final h = m['profileHueSatMap'] as Map?, l = m['profileLookTable'] as Map?;
    return RawFrameMetadata(
        format: RawFormat.values.byName(m['format'] as String),
        activeArea: RawActiveArea(
            left: a['left'] as int,
            top: a['top'] as int,
            width: a['width'] as int,
            height: a['height'] as int),
        orientation: m['orientation'] as int,
        blackLevels: list('blackLevels')!,
        whiteLevel: (m['whiteLevel'] as num).toDouble(),
        cameraWhiteBalance: list('cameraWhiteBalance'),
        d65XyzToCamera: list('d65XyzToCamera'),
        baselineExposure: (m['baselineExposure'] as num?)?.toDouble(),
        baselineExposureOffset:
            (m['baselineExposureOffset'] as num?)?.toDouble(),
        profileDynamicRange: m['profileDynamicRange'] as int?,
        profileHintMaxOutputValue:
            (m['profileHintMaxOutputValue'] as num?)?.toDouble(),
        profileToneCurve: list('profileToneCurve'),
        linearizationTable: list('linearizationTable'),
        blackLevelDeltaH: list('blackLevelDeltaH'),
        blackLevelDeltaV: list('blackLevelDeltaV'),
        profileHueSatMap: h == null
            ? null
            : RawProfileHueSatMap(
                hueDivisions: h['h'] as int,
                saturationDivisions: h['s'] as int,
                valueDivisions: h['v'] as int,
                encoding: h['encoding'] as int,
                deltas: (h['deltas'] as List)
                    .map((x) => (x as num).toDouble())
                    .toList()),
        profileLookTable: l == null
            ? null
            : RawProfileLookTable(
                hueDivisions: l['h'] as int,
                saturationDivisions: l['s'] as int,
                valueDivisions: l['v'] as int,
                encoding: l['encoding'] as int,
                deltas: (l['deltas'] as List)
                    .map((x) => (x as num).toDouble())
                    .toList()));
  }
}
