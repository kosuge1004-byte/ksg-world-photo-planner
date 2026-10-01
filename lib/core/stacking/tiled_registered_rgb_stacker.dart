import '../image/linear_rgb_tile_store.dart';
import '../image/raw_saturation_mask.dart';
import '../registration/affine_sampling_transform.dart';
import '../registration/tiled_affine_rgb_resampler.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'tiled_kappa_sigma_combiner.dart';

/// One demosaiced frame and the inverse map that aligns output coordinates to
/// its source coordinates. Store ownership remains with the caller.
final class RegisteredRgbFrame {
  RegisteredRgbFrame({
    required this.store,
    required this.transform,
    required this.weight,
    this.saturationInfluenceMask,
  }) {
    if (!weight.isFinite || weight <= 0) {
      throw ArgumentError.value(weight, 'weight');
    }
  }

  final LinearRgbTileStore store;
  final AffineSamplingTransform transform;
  final double weight;
  final RawSaturationMask? saturationInfluenceMask;
}

/// Connects bounded affine resampling directly to bounded rejection stacking.
///
/// It does not cache aligned frames. Every requested stack band is sampled
/// from the corresponding file-backed source region and released before the
/// next frame is read.
final class TiledRegisteredRgbStacker {
  const TiledRegisteredRgbStacker({
    this.resampler = const TiledAffineRgbResampler(
      interpolation: ResamplingInterpolation.bicubic,
    ),
    this.combiner = const TiledKappaSigmaCombiner(),
  });

  final TiledAffineRgbResampler resampler;
  final TiledKappaSigmaCombiner combiner;

  Future<RejectionStackedRgbTile> combineTile({
    required List<RegisteredRgbFrame> frames,
    required OverlappedTile outputTile,
    required int outputImageWidth,
    required int outputImageHeight,
    bool Function()? isCancelled,
    void Function(double progress)? reportProgress,
  }) {
    if (frames.isEmpty) {
      throw ArgumentError.value(
          frames, 'frames', 'At least one frame is required.');
    }
    return combiner.combineTile(
      frameCount: frames.length,
      frameWeights: <double>[
        for (final RegisteredRgbFrame frame in frames) frame.weight
      ],
      outputTile: outputTile,
      isCancelled: isCancelled,
      reportProgress: reportProgress,
      readFrame: (int frameIndex, OverlappedTile region) {
        final RegisteredRgbFrame frame = frames[frameIndex];
        return resampler.sampleTile(
          source: frame.store,
          outputTile: region,
          outputImageWidth: outputImageWidth,
          outputImageHeight: outputImageHeight,
          transform: frame.transform,
          isCancelled: isCancelled,
        );
      },
    );
  }
}
