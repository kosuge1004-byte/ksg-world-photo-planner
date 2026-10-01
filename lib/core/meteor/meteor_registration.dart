import '../image/linear_rgb_tile_store.dart';
import '../registration/affine_sampling_transform.dart';
import '../registration/star_detector.dart';
import '../session/milky_way_pipeline.dart';

/// One common reference grid for background and selected meteor pixels.
/// Failed stellar registration is explicit; identity is never a quality fallback.
Future<Map<int, AffineSamplingTransform>> registerMeteorFrames({
  required List<LinearRgbTileStore?> frameStores,
  required Set<int> requiredIndices,
  required int referenceIndex,
  bool Function()? isCancelled,
}) async {
  final stars = <int, List<DetectedStar>>{};
  final indices = {...requiredIndices, referenceIndex}.toList()..sort();
  for (final index in indices) {
    if (isCancelled?.call() ?? false) {
      throw StateError('Meteor registration cancelled.');
    }
    final store = frameStores[index];
    if (store == null) throw StateError('Meteor frame $index is not decoded.');
    stars[index] =
        await detectMilkyWayRegistrationStars(store, isCancelled: isCancelled);
  }
  final plan = buildMilkyWayRegistrationPlan(
    sourcePaths: List.generate(frameStores.length, (i) => 'frame:$i'),
    detectedStarsByFrame: stars,
    referenceIndex: referenceIndex,
    minRegisteredFrames: indices.length == 1 ? 1 : 2,
    enableLocalRegistration: false,
  );
  final transforms = {
    for (final frame in plan.frames) frame.frameIndex: frame.transform
  };
  for (final index in indices) {
    if (!transforms.containsKey(index)) {
      throw StateError('流星合成の星位置合わせに失敗しました。frame=$index / '
          '${plan.diagnostics[index].excludedReason}');
    }
  }
  return transforms;
}
