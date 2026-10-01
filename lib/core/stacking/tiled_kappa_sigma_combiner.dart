import 'dart:math' as math;
import 'dart:typed_data';

import '../image/linear_rgb_tile.dart';
import '../registration/tiled_affine_rgb_resampler.dart';
import '../tiles/overlapped_tile_plan.dart';

typedef CoveredRgbRegionReader = Future<CoveredLinearRgbTile> Function(
  int frameIndex,
  OverlappedTile outputRegion,
);

class TiledStackingCancelled implements Exception {
  const TiledStackingCancelled();

  @override
  String toString() => 'Tiled rejection stacking was cancelled.';
}

/// Combined RGB plus the exact surviving observation count for every channel.
final class RejectionStackedRgbTile {
  RejectionStackedRgbTile({
    required this.tile,
    required Uint16List contributingSamples,
  }) : contributingSamples = contributingSamples {
    if (contributingSamples.length != tile.interleavedRgb.length) {
      throw ArgumentError('Contribution count does not match the RGB tile.');
    }
  }

  final LinearRgbTile tile;
  final Uint16List contributingSamples;
}

/// Exact iterative weighted Kappa-Sigma clipping with bounded working memory.
///
/// The caller supplies one covered, already-aligned RGB region at a time.
/// This combiner deliberately re-reads/resamples frames for each statistics
/// pass instead of retaining all aligned frames. Output tiles are subdivided
/// into bands, so working memory is bounded by [maximumPixelsPerBand] and
/// [maximumIterations], not by full image size or frame count.
final class TiledKappaSigmaCombiner {
  const TiledKappaSigmaCombiner({
    this.kappa = 2.5,
    this.maximumIterations = 3,
    this.minimumSurvivingFrames = 1,
    this.robustSmallStackInitialization = false,
    this.enableOutlierRejection = true,
    this.synchronizeRgbRejection = false,
    this.maximumFramesForRobustInitialization = 7,
    this.maximumPixelsPerBand = 65536,
    this.maximumOutputTilePixels = 1048576,
    this.maximumAlignedFrameCacheBytes = 32 * 1024 * 1024,
  })  : assert(kappa > 0),
        assert(maximumIterations > 0),
        assert(minimumSurvivingFrames > 0),
        assert(maximumFramesForRobustInitialization >= 3),
        assert(maximumPixelsPerBand > 0),
        assert(maximumOutputTilePixels > 0),
        assert(maximumAlignedFrameCacheBytes >= 0);

  static const int maximumAllowedIterations = 16;

  final double kappa;
  final int maximumIterations;
  final int minimumSurvivingFrames;

  /// Seeds the iterative weighted kappa-sigma history with an exact
  /// median/MAD pass when the number of frames is small.  With an ordinary
  /// mean/population-standard-deviation first pass, one arbitrarily large
  /// isolated outlier has a standardized residual of sqrt(n - 1) for equal
  /// weights.  At the production default kappa=2.5 that means 3..7 frame
  /// stacks cannot reject even an arbitrarily large single-frame transient.
  ///
  /// Kept opt-in at this low-level API for backward compatibility. Production
  /// Milky-Way/meteor robust-stack paths explicitly enable it.
  final bool robustSmallStackInitialization;

  /// When false, preserves every covered aligned sample and performs only
  /// the final weighted mean. This is used when transient content such as
  /// meteors must be retained instead of treated as an outlier.
  final bool enableOutlierRejection;

  /// When true, the final rejection decision is synchronized across R/G/B:
  /// one frame either contributes all three channels at a pixel or none.
  /// This prevents independent channel clipping from assembling a coloured
  /// output pixel from different source-frame subsets. If the intersection of
  /// the three channel survivor sets would contain fewer than
  /// [minimumSurvivingFrames], rejection is disabled for that pixel and all
  /// covered frames are used instead. This preserves colour coherence without
  /// allowing rejection itself to collapse a pixel to a single observation.
  ///
  /// Kept opt-in for backward compatibility; the Milky Way path enables it.
  final bool synchronizeRgbRejection;

  /// Upper frame-count bound for the exact robust seed.  The seed retains at
  /// most this many aligned band reads at once, so its extra memory remains
  /// bounded independently of arbitrarily large stack sizes.
  final int maximumFramesForRobustInitialization;

  final int maximumPixelsPerBand;
  final int maximumOutputTilePixels;

  /// Reuses exactly the same aligned Float32 samples across robust-seed,
  /// mean, variance, candidate and final passes. This removes repeated file
  /// reads and bicubic/dual-alignment work without changing the numeric input
  /// to the combiner. The cache is band-bounded and disabled automatically
  /// when the requested frame set would exceed this cap.
  final int maximumAlignedFrameCacheBytes;

  Future<RejectionStackedRgbTile> combineTile({
    required int frameCount,
    required List<double> frameWeights,
    required OverlappedTile outputTile,
    required CoveredRgbRegionReader readFrame,
    bool Function()? isCancelled,
    void Function(double progress)? reportProgress,
  }) async {
    _validate(frameCount, frameWeights, outputTile);
    final List<double> weights = _normalizedWeights(frameWeights);
    final int width = outputTile.outputWidth;
    final int height = outputTile.outputHeight;
    final Float32List output = Float32List(width * height * 3);
    final Uint16List contributions = Uint16List(output.length);
    final int bandHeight = math.max(
      1,
      effectiveBandPixels(frameCount: frameCount, tileWidth: width) ~/ width,
    );
    int completedRows = 0;

    for (int startY = 0; startY < height; startY += bandHeight) {
      _throwIfCancelled(isCancelled);
      final int currentHeight = math.min(bandHeight, height - startY);
      final OverlappedTile band = OverlappedTile(
        outputX: outputTile.outputX,
        outputY: outputTile.outputY + startY,
        outputWidth: width,
        outputHeight: currentHeight,
        inputX: outputTile.outputX,
        inputY: outputTile.outputY + startY,
        inputWidth: width,
        inputHeight: currentHeight,
      );
      final _CombinedBand combined = await _combineBand(
        frameCount: frameCount,
        weights: weights,
        band: band,
        readFrame: readFrame,
        isCancelled: isCancelled,
      );
      final int destinationStart = startY * width * 3;
      output.setRange(
        destinationStart,
        destinationStart + combined.rgb.length,
        combined.rgb,
      );
      contributions.setRange(
        destinationStart,
        destinationStart + combined.contributions.length,
        combined.contributions,
      );
      completedRows += currentHeight;
      reportProgress?.call(completedRows / height);
    }

    return RejectionStackedRgbTile(
      tile: LinearRgbTile(
        x: outputTile.outputX,
        y: outputTile.outputY,
        width: width,
        height: height,
        interleavedRgb: output,
      ),
      contributingSamples: contributions,
    );
  }

  /// WORK350: band size that lets the aligned-frame cache hold every frame.
  ///
  /// Every statistics pass (mean, variance, candidate count per iteration,
  /// plus the final mean) needs each aligned frame of the band. Without the
  /// cache each pass re-reads and re-resamples every frame, i.e. up to
  /// 3 x [maximumIterations] + 1 identical reads per frame and band. When the
  /// configured band would overflow [maximumAlignedFrameCacheBytes] the band
  /// is shrunk until the cache fits instead of silently dropping to the
  /// re-read path.
  ///
  /// Result-neutral: every statistic is per sample, accumulated over frames in
  /// frame order, and a band's early exit only happens once no sample in it
  /// rejects anything further, which leaves every sample's survivor set,
  /// mean and threshold unchanged. The cache returns the very objects a
  /// re-read would recompute (readers allocate fresh buffers and nothing here
  /// mutates them), so outputs and contribution counts are bit-identical;
  /// see test/tiled_kappa_sigma_combiner_cache_equivalence_test.dart.
  ///
  /// Falls back to [maximumPixelsPerBand] (re-read path, same results) when
  /// not even one full row of every frame fits the cache budget.
  int effectiveBandPixels({required int frameCount, required int tileWidth}) {
    if (maximumAlignedFrameCacheBytes <= 0 || frameCount <= 0) {
      return maximumPixelsPerBand;
    }
    final int bytesPerBandPixel =
        frameCount * (3 * Float32List.bytesPerElement + Uint8List.bytesPerElement);
    final int cacheablePixels = maximumAlignedFrameCacheBytes ~/ bytesPerBandPixel;
    if (cacheablePixels < tileWidth) return maximumPixelsPerBand;
    return math.min(maximumPixelsPerBand, cacheablePixels);
  }

  Future<_CombinedBand> _combineBand({
    required int frameCount,
    required List<double> weights,
    required OverlappedTile band,
    required CoveredRgbRegionReader readFrame,
    required bool Function()? isCancelled,
  }) async {
    final int sampleCount = band.outputWidth * band.outputHeight * 3;
    final int estimatedCacheBytes = frameCount *
        band.outputWidth *
        band.outputHeight *
        (3 * Float32List.bytesPerElement + Uint8List.bytesPerElement);
    final List<CoveredLinearRgbTile>? alignedFrames =
        maximumAlignedFrameCacheBytes > 0 &&
                estimatedCacheBytes <= maximumAlignedFrameCacheBytes
            ? <CoveredLinearRgbTile>[
                for (int frame = 0; frame < frameCount; frame++)
                  await _readValidated(frame, band, readFrame),
              ]
            : null;
    Future<CoveredLinearRgbTile> readAligned(int frame, OverlappedTile _) =>
        alignedFrames == null
            ? _readValidated(frame, band, readFrame)
            : Future<CoveredLinearRgbTile>.value(alignedFrames[frame]);
    final List<Float64List> historicalMeans = <Float64List>[];
    final List<Float64List> historicalThresholds = <Float64List>[];
    final List<Uint8List> historicalEnabled = <Uint8List>[];

    if (enableOutlierRejection &&
        robustSmallStackInitialization &&
        frameCount >= 3 &&
        frameCount <= maximumFramesForRobustInitialization) {
      await _seedRobustSmallStackHistory(
        frameCount: frameCount,
        band: band,
        readFrame: readAligned,
        isCancelled: isCancelled,
        historicalMeans: historicalMeans,
        historicalThresholds: historicalThresholds,
        historicalEnabled: historicalEnabled,
      );
    }

    for (int iteration = 0;
        enableOutlierRejection && iteration < maximumIterations;
        iteration++) {
      final Float64List sums = Float64List(sampleCount);
      final Float64List weightSums = Float64List(sampleCount);
      final Uint32List survivorCounts = Uint32List(sampleCount);
      for (int frame = 0; frame < frameCount; frame++) {
        _throwIfCancelled(isCancelled);
        final CoveredLinearRgbTile input = await _readValidated(
          frame,
          band,
          readAligned,
        );
        _accumulateMean(
          input,
          weights[frame],
          historicalMeans,
          historicalThresholds,
          historicalEnabled,
          sums,
          weightSums,
          survivorCounts,
        );
      }
      // The weighted sums have no later use in this iteration. Convert them
      // to means in place to avoid one full Float64 band allocation while
      // preserving the exact division order and stored history values.
      final Float64List means = sums;
      for (int index = 0; index < sampleCount; index++) {
        if (weightSums[index] > 0) {
          means[index] /= weightSums[index];
        }
      }

      final Float64List varianceSums = Float64List(sampleCount);
      for (int frame = 0; frame < frameCount; frame++) {
        _throwIfCancelled(isCancelled);
        final CoveredLinearRgbTile input = await _readValidated(
          frame,
          band,
          readAligned,
        );
        _accumulateVariance(
          input,
          weights[frame],
          historicalMeans,
          historicalThresholds,
          historicalEnabled,
          means,
          varianceSums,
        );
      }

      final Float64List thresholds = Float64List(sampleCount);
      final Uint8List eligible = Uint8List(sampleCount);
      for (int index = 0; index < sampleCount; index++) {
        if (survivorCounts[index] <= minimumSurvivingFrames ||
            weightSums[index] <= 0) {
          continue;
        }
        final double variance = varianceSums[index] / weightSums[index];
        if (!variance.isFinite || variance < 0) {
          throw StateError('Stack variance is invalid.');
        }
        final double threshold = kappa * math.sqrt(variance);
        if (threshold > 1e-12 && threshold.isFinite) {
          thresholds[index] = threshold;
          eligible[index] = 1;
        }
      }

      final Uint32List candidateCounts = Uint32List(sampleCount);
      for (int frame = 0; frame < frameCount; frame++) {
        _throwIfCancelled(isCancelled);
        final CoveredLinearRgbTile input = await _readValidated(
          frame,
          band,
          readAligned,
        );
        _countCandidates(
          input,
          historicalMeans,
          historicalThresholds,
          historicalEnabled,
          means,
          thresholds,
          eligible,
          candidateCounts,
        );
      }

      final Uint8List enabled = Uint8List(sampleCount);
      bool rejectedAny = false;
      for (int index = 0; index < sampleCount; index++) {
        if (eligible[index] != 0 &&
            candidateCounts[index] >= minimumSurvivingFrames &&
            candidateCounts[index] < survivorCounts[index]) {
          enabled[index] = 1;
          rejectedAny = true;
        }
      }
      historicalMeans.add(means);
      historicalThresholds.add(thresholds);
      historicalEnabled.add(enabled);
      if (!rejectedAny) break;
    }

    final Float64List finalSums = Float64List(sampleCount);
    final Float64List finalWeightSums = Float64List(sampleCount);
    final Uint16List finalCounts = Uint16List(sampleCount);
    if (synchronizeRgbRejection) {
      final int pixelCount = sampleCount ~/ 3;
      final Uint16List synchronizedSurvivorCounts = Uint16List(pixelCount);
      final Uint16List coveredCounts = Uint16List(pixelCount);

      // First determine the intersection of the three per-channel survivor
      // sets. We intentionally keep the established per-channel statistics
      // and thresholds, but a source frame may only contribute to the final
      // RGB pixel if all three channels survive those tests together.
      for (int frame = 0; frame < frameCount; frame++) {
        _throwIfCancelled(isCancelled);
        final CoveredLinearRgbTile input = await _readValidated(
          frame,
          band,
          readAligned,
        );
        for (int pixel = 0; pixel < input.coverage.length; pixel++) {
          if (input.coverage[pixel] == 0) continue;
          if (coveredCounts[pixel] == 65535) {
            throw StateError('Stack coverage counter overflow.');
          }
          coveredCounts[pixel]++;
          final int base = pixel * 3;
          if (_pixelSurvivesAllChannels(
            input: input,
            base: base,
            historicalMeans: historicalMeans,
            historicalThresholds: historicalThresholds,
            historicalEnabled: historicalEnabled,
          )) {
            if (synchronizedSurvivorCounts[pixel] == 65535) {
              throw StateError('Stack contribution counter overflow.');
            }
            synchronizedSurvivorCounts[pixel]++;
          }
        }
      }

      // If synchronized clipping would leave too few observations, fall back
      // to all covered frames for that pixel. This is a deliberate quality
      // fail-safe: retaining a possible transient is preferable to claiming a
      // noise-reduced stack from a rejection-induced one-frame survivor.
      for (int frame = 0; frame < frameCount; frame++) {
        _throwIfCancelled(isCancelled);
        final CoveredLinearRgbTile input = await _readValidated(
          frame,
          band,
          readAligned,
        );
        final double weight = weights[frame];
        for (int pixel = 0; pixel < input.coverage.length; pixel++) {
          if (input.coverage[pixel] == 0) continue;
          final int base = pixel * 3;
          final bool applyRejection =
              synchronizedSurvivorCounts[pixel] >= minimumSurvivingFrames;
          if (applyRejection &&
              !_pixelSurvivesAllChannels(
                input: input,
                base: base,
                historicalMeans: historicalMeans,
                historicalThresholds: historicalThresholds,
                historicalEnabled: historicalEnabled,
              )) {
            continue;
          }
          for (int channel = 0; channel < 3; channel++) {
            final int index = base + channel;
            final double sample = input.tile.interleavedRgb[index];
            finalSums[index] += sample * weight;
            finalWeightSums[index] += weight;
            if (finalCounts[index] == 65535) {
              throw StateError('Stack contribution counter overflow.');
            }
            finalCounts[index]++;
          }
        }
      }
    } else {
      for (int frame = 0; frame < frameCount; frame++) {
        _throwIfCancelled(isCancelled);
        final CoveredLinearRgbTile input = await _readValidated(
          frame,
          band,
          readAligned,
        );
        final double weight = weights[frame];
        for (int pixel = 0; pixel < input.coverage.length; pixel++) {
          if (input.coverage[pixel] == 0) continue;
          final int base = pixel * 3;
          for (int channel = 0; channel < 3; channel++) {
            final int index = base + channel;
            final double sample = input.tile.interleavedRgb[index];
            if (!_survives(
              sample,
              index,
              historicalMeans,
              historicalThresholds,
              historicalEnabled,
            )) {
              continue;
            }
            finalSums[index] += sample * weight;
            finalWeightSums[index] += weight;
            if (finalCounts[index] == 65535) {
              throw StateError('Stack contribution counter overflow.');
            }
            finalCounts[index]++;
          }
        }
      }
    }

    final Float32List rgb = Float32List(sampleCount);
    for (int index = 0; index < sampleCount; index++) {
      if (finalWeightSums[index] > 0) {
        final double value = finalSums[index] / finalWeightSums[index];
        if (!value.isFinite || value.abs() > 3.4028234663852886e38) {
          throw StateError('Stack output is outside finite FP32 range.');
        }
        rgb[index] = value;
      }
    }
    return _CombinedBand(rgb: rgb, contributions: finalCounts);
  }

  static const double _madToGaussianSigma = 1.482602218505602;

  bool _pixelSurvivesAllChannels({
    required CoveredLinearRgbTile input,
    required int base,
    required List<Float64List> historicalMeans,
    required List<Float64List> historicalThresholds,
    required List<Uint8List> historicalEnabled,
  }) {
    for (int channel = 0; channel < 3; channel++) {
      final int index = base + channel;
      if (!_survives(
        input.tile.interleavedRgb[index],
        index,
        historicalMeans,
        historicalThresholds,
        historicalEnabled,
      )) {
        return false;
      }
    }
    return true;
  }

  Future<void> _seedRobustSmallStackHistory({
    required int frameCount,
    required OverlappedTile band,
    required CoveredRgbRegionReader readFrame,
    required bool Function()? isCancelled,
    required List<Float64List> historicalMeans,
    required List<Float64List> historicalThresholds,
    required List<Uint8List> historicalEnabled,
  }) async {
    final int sampleCount = band.outputWidth * band.outputHeight * 3;
    final List<CoveredLinearRgbTile> frames = <CoveredLinearRgbTile>[];
    for (int frame = 0; frame < frameCount; frame++) {
      _throwIfCancelled(isCancelled);
      frames.add(await _readValidated(frame, band, readFrame));
    }

    final Float64List centers = Float64List(sampleCount);
    final Float64List thresholds = Float64List(sampleCount);
    final Uint8List enabled = Uint8List(sampleCount);
    final List<double> values = List<double>.filled(frameCount, 0);
    final List<double> deviations = List<double>.filled(frameCount, 0);

    for (int index = 0; index < sampleCount; index++) {
      final int pixel = index ~/ 3;
      int contributing = 0;
      for (final CoveredLinearRgbTile frame in frames) {
        if (frame.coverage[pixel] == 0) continue;
        values[contributing++] = frame.tile.interleavedRgb[index];
      }
      if (contributing <= minimumSurvivingFrames || contributing < 3) {
        continue;
      }

      final double center = _medianPrefix(values, contributing);
      for (int i = 0; i < contributing; i++) {
        deviations[i] = (values[i] - center).abs();
      }
      final double mad = _medianPrefix(deviations, contributing);
      if (!center.isFinite || !mad.isFinite || mad < 0) {
        throw StateError('Robust small-stack center/spread is invalid.');
      }

      double threshold;
      if (mad == 0) {
        threshold = 1e-12 * math.max(1.0, center.abs());
      } else {
        threshold = kappa * _madToGaussianSigma * mad;
      }
      if (!threshold.isFinite || threshold < 0) {
        throw StateError('Robust small-stack threshold is invalid.');
      }

      int candidates = 0;
      for (int i = 0; i < contributing; i++) {
        if ((values[i] - center).abs() <= threshold) candidates++;
      }
      if (candidates >= minimumSurvivingFrames && candidates < contributing) {
        centers[index] = center;
        thresholds[index] = threshold;
        enabled[index] = 1;
      }
    }

    historicalMeans.add(centers);
    historicalThresholds.add(thresholds);
    historicalEnabled.add(enabled);
  }

  double _medianPrefix(List<double> values, int length) {
    final List<double> sorted = <double>[
      for (int i = 0; i < length; i++) values[i]
    ]..sort();
    final int middle = length ~/ 2;
    if (length.isOdd) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) * 0.5;
  }

  void _accumulateMean(
    CoveredLinearRgbTile input,
    double weight,
    List<Float64List> historicalMeans,
    List<Float64List> historicalThresholds,
    List<Uint8List> historicalEnabled,
    Float64List sums,
    Float64List weightSums,
    Uint32List counts,
  ) {
    for (int pixel = 0; pixel < input.coverage.length; pixel++) {
      if (input.coverage[pixel] == 0) continue;
      final int base = pixel * 3;
      for (int channel = 0; channel < 3; channel++) {
        final int index = base + channel;
        final double sample = input.tile.interleavedRgb[index];
        if (!_survives(
          sample,
          index,
          historicalMeans,
          historicalThresholds,
          historicalEnabled,
        )) {
          continue;
        }
        sums[index] += sample * weight;
        weightSums[index] += weight;
        counts[index]++;
      }
    }
  }

  void _accumulateVariance(
    CoveredLinearRgbTile input,
    double weight,
    List<Float64List> historicalMeans,
    List<Float64List> historicalThresholds,
    List<Uint8List> historicalEnabled,
    Float64List means,
    Float64List varianceSums,
  ) {
    for (int pixel = 0; pixel < input.coverage.length; pixel++) {
      if (input.coverage[pixel] == 0) continue;
      final int base = pixel * 3;
      for (int channel = 0; channel < 3; channel++) {
        final int index = base + channel;
        final double sample = input.tile.interleavedRgb[index];
        if (!_survives(
          sample,
          index,
          historicalMeans,
          historicalThresholds,
          historicalEnabled,
        )) {
          continue;
        }
        final double difference = sample - means[index];
        varianceSums[index] += difference * difference * weight;
      }
    }
  }

  void _countCandidates(
    CoveredLinearRgbTile input,
    List<Float64List> historicalMeans,
    List<Float64List> historicalThresholds,
    List<Uint8List> historicalEnabled,
    Float64List means,
    Float64List thresholds,
    Uint8List eligible,
    Uint32List candidateCounts,
  ) {
    for (int pixel = 0; pixel < input.coverage.length; pixel++) {
      if (input.coverage[pixel] == 0) continue;
      final int base = pixel * 3;
      for (int channel = 0; channel < 3; channel++) {
        final int index = base + channel;
        if (eligible[index] == 0) continue;
        final double sample = input.tile.interleavedRgb[index];
        if (_survives(
              sample,
              index,
              historicalMeans,
              historicalThresholds,
              historicalEnabled,
            ) &&
            (sample - means[index]).abs() <= thresholds[index]) {
          candidateCounts[index]++;
        }
      }
    }
  }

  bool _survives(
    double sample,
    int index,
    List<Float64List> means,
    List<Float64List> thresholds,
    List<Uint8List> enabled,
  ) {
    for (int iteration = 0; iteration < means.length; iteration++) {
      if (enabled[iteration][index] != 0 &&
          (sample - means[iteration][index]).abs() >
              thresholds[iteration][index]) {
        return false;
      }
    }
    return true;
  }

  Future<CoveredLinearRgbTile> _readValidated(
    int frame,
    OverlappedTile band,
    CoveredRgbRegionReader reader,
  ) async {
    final CoveredLinearRgbTile input = await reader(frame, band);
    final LinearRgbTile tile = input.tile;
    if (tile.x != band.outputX ||
        tile.y != band.outputY ||
        tile.width != band.outputWidth ||
        tile.height != band.outputHeight) {
      throw StateError('Covered RGB reader returned an unexpected region.');
    }
    if (tile.interleavedRgb.any((double value) => !value.isFinite)) {
      throw StateError('Covered RGB reader returned a non-finite sample.');
    }
    return input;
  }

  List<double> _normalizedWeights(List<double> weights) {
    final double maximum = weights.reduce(math.max);
    final List<double> normalized = <double>[
      for (final double weight in weights) weight / maximum,
    ];
    if (normalized.any((double weight) => weight <= 0 || !weight.isFinite)) {
      throw ArgumentError('Frame-weight dynamic range is too large.');
    }
    return normalized;
  }

  void _validate(
    int frameCount,
    List<double> weights,
    OverlappedTile tile,
  ) {
    if (frameCount <= 0 || frameCount > 65535) {
      throw ArgumentError.value(frameCount, 'frameCount');
    }
    if (weights.length != frameCount ||
        weights.any((double weight) => !weight.isFinite || weight <= 0)) {
      throw ArgumentError.value(weights, 'frameWeights');
    }
    if (!kappa.isFinite ||
        kappa <= 0 ||
        maximumIterations <= 0 ||
        maximumIterations > maximumAllowedIterations ||
        minimumSurvivingFrames <= 0 ||
        minimumSurvivingFrames > frameCount ||
        maximumFramesForRobustInitialization < 3 ||
        maximumAlignedFrameCacheBytes < 0 ||
        maximumPixelsPerBand <= 0 ||
        maximumOutputTilePixels <= 0 ||
        tile.outputX < 0 ||
        tile.outputY < 0 ||
        tile.outputWidth <= 0 ||
        tile.outputHeight <= 0 ||
        tile.outputWidth > maximumPixelsPerBand ||
        tile.outputWidth * tile.outputHeight > maximumOutputTilePixels) {
      throw ArgumentError('Invalid tiled stack configuration.');
    }
  }

  void _throwIfCancelled(bool Function()? isCancelled) {
    if (isCancelled?.call() ?? false) {
      throw const TiledStackingCancelled();
    }
  }
}

final class _CombinedBand {
  const _CombinedBand({required this.rgb, required this.contributions});

  final Float32List rgb;
  final Uint16List contributions;
}
