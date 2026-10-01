import 'dart:async';
import '../background/native_operation_trace.dart';
import '../background/processing_storage_admission.dart';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:image/image.dart' as img;

import '../image/linear_contribution_tile_store.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import 'bigtiff16_writer.dart';
import 'bmp_writer.dart';
import 'dng_final_render_profile.dart';
import 'dng_profile_hue_sat_map.dart';
import 'dng_profile_look_table.dart';
import 'dng_profile_tone_curve.dart';
import 'linear_dng_writer.dart';
import 'local_tone_adaptation.dart';
import 'output_image_format.dart';
import 'tiff16_writer.dart';
import 'tone_map.dart';

/// Raised when a caller requests cancellation while an image is being
/// tone-mapped or written. A partially written output file is removed before
/// this exception escapes.
class ExportCancelled implements Exception {
  const ExportCancelled();

  @override
  String toString() => 'Image export was cancelled.';
}

void _validateAtomicRenderProfile({
  required DngFinalRenderProfile? renderProfile,
  required double baselineExposureEv,
  required DngProfileHueSatMap? profileHueSatMap,
  required DngProfileLookTable? profileLookTable,
  required DngProfileToneCurve? profileToneCurve,
}) {
  if (renderProfile != null &&
      (baselineExposureEv != 0 ||
          profileHueSatMap != null ||
          profileLookTable != null ||
          profileToneCurve != null)) {
    throw ArgumentError(
      'renderProfile cannot be mixed with individual DNG profile fields.',
    );
  }
}

/// Computes a single, fixed [AutoToneParameters] baseline from one
/// reference frame's own content, meant to be reused for *every* later
/// export of the same shoot (a single-frame preview, the final stack,
/// re-exports at a different quality level, ...) instead of letting each
/// export separately call [estimateAutoToneParameters] on its own,
/// different pixel statistics.
///
/// This exists because leaving every export to auto-tone independently
/// (the original behavior) meant a single frame and its stacked result
/// could legitimately land on different exposure/white point values even
/// though nothing about the actual subject changed — the same root-cause
/// class of surprise Adobe Camera Raw/Lightroom avoid by applying a
/// fixed per-shot `BaselineExposure` from the camera profile and only
/// recomputing on an explicit "Auto" tap, rather than silently
/// re-deriving exposure from whatever the current render happens to
/// contain. This app has no calibrated per-camera baseline table to fall
/// back on, so the fixed baseline here is instead anchored to the
/// reference frame chosen for registration — still fixed *for that
/// session*, just not fixed across different phones/sensors the way a
/// real camera profile would be.
///
/// Callers should compute this once per session (from the frame already
/// selected as the registration reference) and pass the result as
/// [combineDecodedFramesAndExport]'s / registration export's explicit
/// `exposureScale`/`whitePoint`, rather than leaving them `null`.
Future<AutoToneParameters> estimateFixedToneBaselineFromReferenceFrame({
  required LinearRgbTileStore referenceStore,
  DngFinalRenderProfile? renderProfile,
  double baselineExposureEv = 0,
  bool Function()? isCancelled,
}) =>
    _resolveTileStoreToneParameters(
      tileStore: referenceStore,
      rowsPerStrip: 128,
      exposureScale: null,
      whitePoint: null,
      baselineExposureEv:
          renderProfile?.baselineExposureEv ?? baselineExposureEv,
      renderProfile: renderProfile,
      isCancelled: isCancelled,
    );

List<double>? _sourceLuminanceWeightsForRenderProfile(
  DngFinalRenderProfile? renderProfile,
) {
  final transform = renderProfile?.linearColorTransform;
  if (transform == null) return null;
  final List<double> destinationWeights =
      renderProfile?.postProfileColorTransform != null
          ? linearProPhotoD50LuminanceWeights
          : bt709LinearLuminanceWeights;
  final List<double> matrix = transform.matrix;
  final List<double> sourceWeights = <double>[
    destinationWeights[0] * matrix[0] +
        destinationWeights[1] * matrix[3] +
        destinationWeights[2] * matrix[6],
    destinationWeights[0] * matrix[1] +
        destinationWeights[1] * matrix[4] +
        destinationWeights[2] * matrix[7],
    destinationWeights[0] * matrix[2] +
        destinationWeights[1] * matrix[5] +
        destinationWeights[2] * matrix[8],
  ];
  return sourceWeights.every((double value) => value.isFinite)
      ? sourceWeights
      : null;
}

Float32List _prepareAutoToneSampleForRenderProfile(
  Float32List rgb,
  DngFinalRenderProfile? renderProfile,
) {
  final DngProfileHueSatMap? hueSatMap = renderProfile?.hueSatMap;
  if (renderProfile == null || hueSatMap == null) return rgb;
  if (rgb.length % 3 != 0) {
    throw InvalidToneMapInput(
      'DNG auto-tone samples require complete interleaved RGB triples.',
    );
  }

  final Float32List output = Float32List(rgb.length);
  final Float64List working = Float64List(3);
  final Float64List mapped = Float64List(3);
  for (int base = 0; base < rgb.length; base += 3) {
    final transform = renderProfile.linearColorTransform;
    if (transform != null) {
      transform.transformPixel(
        rgb[base],
        rgb[base + 1],
        rgb[base + 2],
        working,
      );
    } else {
      // postColorFromMetadata is used by CFA drizzle after it has already
      // established linear ProPhoto RGB. Keep those samples in the same
      // working space and sanitize only non-finite values.
      working[0] = rgb[base].isFinite ? rgb[base] : 0;
      working[1] = rgb[base + 1].isFinite ? rgb[base + 1] : 0;
      working[2] = rgb[base + 2].isFinite ? rgb[base + 2] : 0;
    }
    hueSatMap.transformPixel(
      math.max(0, working[0]),
      math.max(0, working[1]),
      math.max(0, working[2]),
      mapped,
    );
    output[base] = mapped[0];
    output[base + 1] = mapped[1];
    output[base + 2] = mapped[2];
  }
  return output;
}

List<double> _autoToneLuminanceWeightsForPreparedSample(
  DngFinalRenderProfile? renderProfile,
) {
  if (renderProfile?.hueSatMap != null) {
    // HueSatMap is applied in linear ProPhoto RGB (D50/RIMM), before
    // exposure. The prepared sample above therefore lives in that space.
    return linearProPhotoD50LuminanceWeights;
  }
  return _sourceLuminanceWeightsForRenderProfile(renderProfile) ??
      bt709LinearLuminanceWeights;
}

enum Tiff16Container { classic, bigTiff }

Tiff16Container recommendedTiff16Container({
  required int width,
  required int height,
  int rowsPerStrip = 128,
}) {
  if (width <= 0 || height <= 0 || rowsPerStrip <= 0) {
    throw InvalidTiffInput('width, height and rowsPerStrip must be positive.');
  }
  final int maximumClassicFileLength = classicTiffMaximumOffset;
  final int rawPixelBytes = width * height * 6;
  final int metadataBytes = classicTiff16PixelDataOffsetFor(
    height: height,
    rowsPerStrip: rowsPerStrip,
  );
  return metadataBytes + rawPixelBytes > maximumClassicFileLength
      ? Tiff16Container.bigTiff
      : Tiff16Container.classic;
}

void _throwIfCancelled(bool Function()? isCancelled) {
  if (isCancelled?.call() ?? false) throw const ExportCancelled();
}

Future<AutoToneParameters> _resolveTileStoreToneParameters({
  required LinearRgbTileStore tileStore,
  required int rowsPerStrip,
  required double? exposureScale,
  required double? whitePoint,
  required double baselineExposureEv,
  DngFinalRenderProfile? renderProfile,
  bool Function()? isCancelled,
}) async {
  if (exposureScale != null && whitePoint != null) {
    return AutoToneParameters(
      exposureScale: exposureScale,
      whitePoint: whitePoint,
    );
  }
  const int maximumSamplePixels = 500000;
  final int pixelCount = tileStore.width * tileStore.height;
  final int sampleStep =
      math.max(1, math.sqrt(pixelCount / maximumSamplePixels).ceil());
  final int sampleWidth = (tileStore.width + sampleStep - 1) ~/ sampleStep;
  final int sampleHeight = (tileStore.height + sampleStep - 1) ~/ sampleStep;
  final Float32List sampledRgb = Float32List(sampleWidth * sampleHeight * 3);
  int destination = 0;
  for (int y = 0; y < tileStore.height; y += rowsPerStrip) {
    _throwIfCancelled(isCancelled);
    final int stripHeight = math.min(rowsPerStrip, tileStore.height - y);
    final LinearRgbTile strip = await tileStore.readRegion(
      x: 0,
      y: y,
      width: tileStore.width,
      height: stripHeight,
    );
    int globalY = ((y + sampleStep - 1) ~/ sampleStep) * sampleStep;
    for (; globalY < y + stripHeight; globalY += sampleStep) {
      final int localY = globalY - y;
      for (int x = 0; x < tileStore.width; x += sampleStep) {
        final int source = (localY * tileStore.width + x) * 3;
        sampledRgb[destination++] = strip.interleavedRgb[source];
        sampledRgb[destination++] = strip.interleavedRgb[source + 1];
        sampledRgb[destination++] = strip.interleavedRgb[source + 2];
      }
    }
  }
  _throwIfCancelled(isCancelled);
  final Float32List rawSample = destination == sampledRgb.length
      ? sampledRgb
      : Float32List.sublistView(sampledRgb, 0, destination);
  final Float32List preparedSample =
      _prepareAutoToneSampleForRenderProfile(rawSample, renderProfile);
  final AutoToneParameters auto = estimateAutoToneParameters(
    preparedSample,
    luminanceWeights: _autoToneLuminanceWeightsForPreparedSample(renderProfile),
  );
  return compensateAutoToneForBaselineExposure(
    auto,
    baselineExposureEv,
  );
}

/// Closes WORK52_PROGRESS.md's step 3 ("write the combined output
/// somewhere durable") for real: reads a finished pipeline result (the
/// [LinearRgbTileStore] `star_trail_pipeline.dart`'s `runStarTrailPipeline`
/// returns directly, or `milky_way_pipeline.dart`'s
/// `MilkyWayPipelineResult.tileStore`, or any other
/// [LinearRgbTileStore]), tone-maps it to a display-referred 8-bit image
/// (`tone_map.dart`), and writes it as a real, standard, openable-today
/// BMP file (`bmp_writer.dart`) — the first concrete "produce a file the
/// user can actually look at" capability anywhere in this project.
///
/// This intentionally does *not* build a results/gallery screen (see
/// WORK52_PROGRESS.md's remaining "step 3" and "step 4" scope) — it is
/// the file-writing piece that screen will eventually call, usable on
/// its own in the meantime (e.g. from a debug/test harness, or a
/// minimal "export" button) without waiting on that larger UI work.
///
/// This file has not been executed against the Dart SDK (unavailable in
/// the environment that wrote it). `tone_map.dart` and `bmp_writer.dart`
/// each have their own dedicated, thoroughly-tested Node references
/// (the latter additionally externally verified against Pillow — see
/// WORK55_PROGRESS.md); this file's own new logic is the comparatively
/// thin "read the whole store, then call both of those" glue, with nothing
/// numerically novel of its own to get wrong.
///
/// [exportLinearRgbTileToBmp] is the core logic; [exportTileStoreToBmp]
/// is a thin wrapper around it for the common "export a whole tile
/// store" case. Split this way (Work61) so a caller that already has a
/// composited [LinearRgbTile] in memory — e.g. `streak_compositor.dart`'s
/// `compositeSelectedStreaks` output, for meteor mode's composite-and-
/// export step (see `meteor_composite_result.dart`) — doesn't need to
/// wrap it in a throwaway [LinearRgbTileStore] just to immediately read
/// it back out again.

/// Tone-maps [tile] (auto-exposing via [estimateAutoToneParameters]
/// unless [exposureScale]/[whitePoint] are both supplied explicitly) and
/// writes the result as a BMP file at [outputPath].
///
/// This is the core export logic, operating directly on an in-memory
/// [LinearRgbTile] rather than a [LinearRgbTileStore] — [exportTileStoreToBmp]
/// (below) is a thin wrapper around this for the common case of
/// exporting a whole tile store's contents. A caller that already has a
/// composited [LinearRgbTile] in memory (e.g. `streak_compositor.dart`'s
/// `compositeSelectedStreaks` output, for meteor mode's eventual
/// composite-and-export step) can call this directly instead of first
/// wrapping that tile in a throwaway store just to immediately read it
/// back out again.
///
/// - [exposureScale], [whitePoint]: if either is `null` (the default),
///   both are computed automatically from the image's own content via
///   [estimateAutoToneParameters] — supplying just one and leaving the
///   other `null` is treated as "compute both automatically", not "use
///   this one value and default the other", since the two parameters
///   are estimated jointly from the same underlying statistics and
///   mixing an explicit value for one with an auto-estimated value for
///   the other has no principled meaning.
///
/// Returns the [File] that was written.
Future<File> exportLinearRgbTileToBmp({
  required LinearRgbTile tile,
  required String outputPath,
  double? exposureScale,
  double baselineExposureEv = 0,
  double? whitePoint,
  double localToneStrength = 0,
  int localToneBlurRadius = 32,
  double localToneReferencePercentile = 0.85,
  double localToneMinGain = 0.25,
  double localToneMaxGain = 4,
  DngProfileHueSatMap? profileHueSatMap,
  DngProfileLookTable? profileLookTable,
  DngProfileToneCurve? profileToneCurve,
  DngFinalRenderProfile? renderProfile,
  bool Function()? isCancelled,
}) async {
  _validateAtomicRenderProfile(
    renderProfile: renderProfile,
    baselineExposureEv: baselineExposureEv,
    profileHueSatMap: profileHueSatMap,
    profileLookTable: profileLookTable,
    profileToneCurve: profileToneCurve,
  );
  _throwIfCancelled(isCancelled);
  // localToneStrength=0(既定値)では local_tone_adaptation.dart 自身が
  // 恒等変換(数値的に無変化)であると保証している(Work99)ため、
  // その場合はブラー計算そのものを丸ごと省略し、既存の呼び出し元の
  // 挙動・処理コストに一切影響を与えないようにする。
  final Float32List sourceRgb = localToneStrength > 0
      ? applyLocalToneAdaptation(
          tile.interleavedRgb,
          tile.width,
          tile.height,
          blurRadius: localToneBlurRadius,
          strength: localToneStrength,
          referencePercentile: localToneReferencePercentile,
          minGain: localToneMinGain,
          maxGain: localToneMaxGain,
          luminanceWeights:
              _sourceLuminanceWeightsForRenderProfile(renderProfile) ??
                  bt709LinearLuminanceWeights,
        )
      : tile.interleavedRgb;

  _throwIfCancelled(isCancelled);
  double effectiveExposureScale;
  double effectiveWhitePoint;
  if (exposureScale != null && whitePoint != null) {
    effectiveExposureScale = exposureScale;
    effectiveWhitePoint = whitePoint;
  } else {
    final Float32List preparedForAutoTone =
        _prepareAutoToneSampleForRenderProfile(sourceRgb, renderProfile);
    final AutoToneParameters auto = compensateAutoToneForBaselineExposure(
      estimateAutoToneParameters(
        preparedForAutoTone,
        luminanceWeights:
            _autoToneLuminanceWeightsForPreparedSample(renderProfile),
      ),
      renderProfile?.baselineExposureEv ?? baselineExposureEv,
    );
    effectiveExposureScale = auto.exposureScale;
    effectiveWhitePoint = auto.whitePoint;
  }

  _throwIfCancelled(isCancelled);
  final Uint8List display = toneMapToDisplayRgb(
    sourceRgb,
    exposureScale: effectiveExposureScale,
    baselineExposureEv: renderProfile?.baselineExposureEv ?? baselineExposureEv,
    whitePoint: effectiveWhitePoint,
    linearColorTransform: renderProfile?.linearColorTransform,
    postProfileColorTransform: renderProfile?.postProfileColorTransform,
    profileHueSatMap: renderProfile?.hueSatMap ?? profileHueSatMap,
    profileLookTable: renderProfile?.lookTable ?? profileLookTable,
    profileToneCurve: renderProfile?.toneCurve ?? profileToneCurve,
  );

  _throwIfCancelled(isCancelled);
  final Uint8List bmp = encodeBmp(
    width: tile.width,
    height: tile.height,
    rgb8: display,
  );

  final File file = File(outputPath);
  bool completed = false;
  try {
    _throwIfCancelled(isCancelled);
    await file.writeAsBytes(bmp, flush: true);
    _throwIfCancelled(isCancelled);
    completed = true;
    return file;
  } finally {
    if (!completed && await file.exists()) await file.delete();
  }
}

/// Reads the entirety of [tileStore] and writes it as a BMP file via
/// [exportLinearRgbTileToBmp]. See that function for the meaning of
/// [exposureScale]/[whitePoint]; forwarded unchanged.
///
/// Returns the [File] that was written.
Future<File> exportTileStoreToBmp({
  required LinearRgbTileStore tileStore,
  required String outputPath,
  double? exposureScale,
  double baselineExposureEv = 0,
  double? whitePoint,
  DngProfileHueSatMap? profileHueSatMap,
  DngProfileLookTable? profileLookTable,
  DngProfileToneCurve? profileToneCurve,
  DngFinalRenderProfile? renderProfile,
  bool Function()? isCancelled,
}) async {
  _validateAtomicRenderProfile(
    renderProfile: renderProfile,
    baselineExposureEv: baselineExposureEv,
    profileHueSatMap: profileHueSatMap,
    profileLookTable: profileLookTable,
    profileToneCurve: profileToneCurve,
  );
  _throwIfCancelled(isCancelled);
  const int rowsPerStrip = 128;
  final AutoToneParameters tone = await _resolveTileStoreToneParameters(
    tileStore: tileStore,
    rowsPerStrip: rowsPerStrip,
    exposureScale: exposureScale,
    whitePoint: whitePoint,
    baselineExposureEv: renderProfile?.baselineExposureEv ?? baselineExposureEv,
    renderProfile: renderProfile,
    isCancelled: isCancelled,
  );

  final File file = File(outputPath);
  final RandomAccessFile output = await file.open(mode: FileMode.write);
  bool completed = false;
  try {
    _throwIfCancelled(isCancelled);
    output.writeFromSync(
      encodeBmpHeader(width: tileStore.width, height: tileStore.height),
    );
    final int stride = bmpRowStrideBytes(tileStore.width);
    final Uint8List bgrRow = Uint8List(stride);
    for (int bottom = tileStore.height; bottom > 0;) {
      _throwIfCancelled(isCancelled);
      final int sourceY = math.max(0, bottom - rowsPerStrip);
      final int stripHeight = bottom - sourceY;
      final LinearRgbTile strip = await tileStore.readRegion(
        x: 0,
        y: sourceY,
        width: tileStore.width,
        height: stripHeight,
      );
      final Uint8List display = toneMapToDisplayRgb(
        strip.interleavedRgb,
        exposureScale: tone.exposureScale,
        baselineExposureEv:
            renderProfile?.baselineExposureEv ?? baselineExposureEv,
        whitePoint: tone.whitePoint,
        linearColorTransform: renderProfile?.linearColorTransform,
        postProfileColorTransform: renderProfile?.postProfileColorTransform,
        profileHueSatMap: renderProfile?.hueSatMap ?? profileHueSatMap,
        profileLookTable: renderProfile?.lookTable ?? profileLookTable,
        profileToneCurve: renderProfile?.toneCurve ?? profileToneCurve,
      );
      for (int localY = stripHeight - 1; localY >= 0; localY--) {
        for (int x = 0; x < tileStore.width; x++) {
          final int source = (localY * tileStore.width + x) * 3;
          final int destination = x * 3;
          bgrRow[destination] = display[source + 2];
          bgrRow[destination + 1] = display[source + 1];
          bgrRow[destination + 2] = display[source];
        }
        output.writeFromSync(bgrRow);
      }
      bottom = sourceY;
    }
    _throwIfCancelled(isCancelled);
    output.flushSync();
    completed = true;
    return file;
  } finally {
    // A close/flush failure must not prevent removal of a partial BMP.
    try {
      await output.close();
    } finally {
      if (!completed && await file.exists()) await file.delete();
    }
  }
}

/// Exports a display-referred full-resolution JPEG.
///
/// The stack itself remains untouched; only the final rendered export is 8-bit
/// JPEG. Rendering uses the same auto-tone/color-profile path as BMP/TIFF.
Future<File> exportTileStoreToJpeg({
  required LinearRgbTileStore tileStore,
  required String outputPath,
  int quality = 95,
  double? exposureScale,
  double baselineExposureEv = 0,
  double? whitePoint,
  DngProfileHueSatMap? profileHueSatMap,
  DngProfileLookTable? profileLookTable,
  DngProfileToneCurve? profileToneCurve,
  DngFinalRenderProfile? renderProfile,
  bool Function()? isCancelled,
}) async {
  if (quality < 1 || quality > 100) {
    throw ArgumentError.value(quality, 'quality');
  }
  _validateAtomicRenderProfile(
    renderProfile: renderProfile,
    baselineExposureEv: baselineExposureEv,
    profileHueSatMap: profileHueSatMap,
    profileLookTable: profileLookTable,
    profileToneCurve: profileToneCurve,
  );
  _throwIfCancelled(isCancelled);
  const int rowsPerStrip = 128;
  final AutoToneParameters tone = await _resolveTileStoreToneParameters(
    tileStore: tileStore,
    rowsPerStrip: rowsPerStrip,
    exposureScale: exposureScale,
    whitePoint: whitePoint,
    baselineExposureEv: renderProfile?.baselineExposureEv ?? baselineExposureEv,
    renderProfile: renderProfile,
    isCancelled: isCancelled,
  );

  // Keep exactly one full-resolution uncompressed RGB8 backing store for the
  // Dart `image` JPEG encoder. Previously we first materialized a separate
  // `Uint8List` and then constructed an `img.Image` from it, which could make
  // a second full-frame allocation/copy depending on the package internals.
  // `Image.toUint8List()` is documented as a direct view of the image storage,
  // so strips are rendered straight into the encoder image buffer.
  final img.Image image = img.Image(
    width: tileStore.width,
    height: tileStore.height,
    numChannels: 3,
  );
  final Uint8List rgb = image.toUint8List();
  if (rgb.length != tileStore.width * tileStore.height * 3) {
    throw StateError('Unexpected JPEG RGB backing-store size.');
  }
  for (int y = 0; y < tileStore.height; y += rowsPerStrip) {
    _throwIfCancelled(isCancelled);
    final int stripHeight = math.min(rowsPerStrip, tileStore.height - y);
    final LinearRgbTile strip = await tileStore.readRegion(
      x: 0,
      y: y,
      width: tileStore.width,
      height: stripHeight,
    );
    final Uint8List display = toneMapToDisplayRgb(
      strip.interleavedRgb,
      exposureScale: tone.exposureScale,
      baselineExposureEv:
          renderProfile?.baselineExposureEv ?? baselineExposureEv,
      whitePoint: tone.whitePoint,
      linearColorTransform: renderProfile?.linearColorTransform,
      postProfileColorTransform: renderProfile?.postProfileColorTransform,
      profileHueSatMap: renderProfile?.hueSatMap ?? profileHueSatMap,
      profileLookTable: renderProfile?.lookTable ?? profileLookTable,
      profileToneCurve: renderProfile?.toneCurve ?? profileToneCurve,
    );
    rgb.setRange(
      y * tileStore.width * 3,
      (y + stripHeight) * tileStore.width * 3,
      display,
    );
  }
  _throwIfCancelled(isCancelled);

  final Uint8List encoded = img.encodeJpg(
    image,
    quality: quality,
    chroma: img.JpegChroma.yuv444,
  );
  final File file = File(outputPath);
  bool completed = false;
  try {
    _throwIfCancelled(isCancelled);
    await file.writeAsBytes(encoded, flush: true);
    _throwIfCancelled(isCancelled);
    completed = true;
    return file;
  } finally {
    if (!completed && await file.exists()) await file.delete();
  }
}

/// Streams a display-referred, unsigned 16-bit RGB TIFF from [tileStore].
/// The full image is never materialized in Dart memory; only one 128-row
/// strip and a bounded auto-tone sample are resident at a time.
Future<File> exportTileStoreToTiff16({
  required LinearRgbTileStore tileStore,
  required String outputPath,
  Tiff16Compression compression = Tiff16Compression.deflate,
  Tiff16Predictor? predictor,
  Tiff16Container container = Tiff16Container.classic,
  double? exposureScale,
  double baselineExposureEv = 0,
  double? whitePoint,
  DngProfileHueSatMap? profileHueSatMap,
  DngProfileLookTable? profileLookTable,
  DngProfileToneCurve? profileToneCurve,
  DngFinalRenderProfile? renderProfile,
  bool Function()? isCancelled,
}) async {
  _validateAtomicRenderProfile(
    renderProfile: renderProfile,
    baselineExposureEv: baselineExposureEv,
    profileHueSatMap: profileHueSatMap,
    profileLookTable: profileLookTable,
    profileToneCurve: profileToneCurve,
  );
  _throwIfCancelled(isCancelled);
  const int rowsPerStrip = 128;
  if (compression != Tiff16Compression.deflate &&
      predictor == Tiff16Predictor.horizontalDifferencing) {
    throw InvalidTiffInput(
      'Horizontal differencing requires Deflate compression.',
    );
  }
  final Uint8List placeholderBytes = switch (container) {
    Tiff16Container.classic => encodeTiff16Header(
        width: tileStore.width,
        height: tileStore.height,
        rowsPerStrip: rowsPerStrip,
        compression: compression,
        deferredStrips: compression == Tiff16Compression.deflate,
      ).bytes,
    Tiff16Container.bigTiff => encodeBigTiff16Header(
        width: tileStore.width,
        height: tileStore.height,
        rowsPerStrip: rowsPerStrip,
        compression: compression,
        deferredStrips: compression == Tiff16Compression.deflate,
      ).bytes,
  };
  final AutoToneParameters tone = await _resolveTileStoreToneParameters(
    tileStore: tileStore,
    rowsPerStrip: rowsPerStrip,
    exposureScale: exposureScale,
    whitePoint: whitePoint,
    baselineExposureEv: renderProfile?.baselineExposureEv ?? baselineExposureEv,
    renderProfile: renderProfile,
    isCancelled: isCancelled,
  );
  final Tiff16Predictor selectedPredictor = predictor ??
      (compression == Tiff16Compression.none
          ? Tiff16Predictor.none
          : await _selectTiff16Predictor(
              tileStore: tileStore,
              tone: tone,
              baselineExposureEv: baselineExposureEv,
              profileHueSatMap: profileHueSatMap,
              profileLookTable: profileLookTable,
              profileToneCurve: profileToneCurve,
              renderProfile: renderProfile,
              isCancelled: isCancelled,
            ));

  final File file = File(outputPath);
  final RandomAccessFile output = await file.open(mode: FileMode.write);
  bool completed = false;
  try {
    _throwIfCancelled(isCancelled);
    output.writeFromSync(placeholderBytes);
    final List<int> stripOffsets = <int>[];
    final List<int> stripByteCounts = <int>[];
    final ZLibEncoder deflateEncoder = ZLibEncoder(level: 6);
    for (int y = 0; y < tileStore.height; y += rowsPerStrip) {
      _throwIfCancelled(isCancelled);
      final int stripHeight = math.min(rowsPerStrip, tileStore.height - y);
      final LinearRgbTile strip = await tileStore.readRegion(
        x: 0,
        y: y,
        width: tileStore.width,
        height: stripHeight,
      );
      final Uint16List display = toneMapToDisplayRgb16(
        strip.interleavedRgb,
        exposureScale: tone.exposureScale,
        baselineExposureEv:
            renderProfile?.baselineExposureEv ?? baselineExposureEv,
        whitePoint: tone.whitePoint,
        linearColorTransform: renderProfile?.linearColorTransform,
        postProfileColorTransform: renderProfile?.postProfileColorTransform,
        profileHueSatMap: renderProfile?.hueSatMap ?? profileHueSatMap,
        profileLookTable: renderProfile?.lookTable ?? profileLookTable,
        profileToneCurve: renderProfile?.toneCurve ?? profileToneCurve,
      );
      final Uint8List encoded = _encodeTiff16Strip(
        display,
        width: tileStore.width,
        predictor: selectedPredictor,
      );
      final Uint8List payload = compression == Tiff16Compression.deflate
          ? Uint8List.fromList(deflateEncoder.convert(encoded))
          : encoded;
      final int stripOffset = output.positionSync();
      if (container == Tiff16Container.classic) {
        validateClassicTiffWriteRange(
          offset: stripOffset,
          byteCount: payload.length,
        );
      } else {
        validateBigTiffWriteRange(
          offset: stripOffset,
          byteCount: payload.length,
        );
      }
      stripOffsets.add(stripOffset);
      stripByteCounts.add(payload.length);
      output.writeFromSync(payload);
    }
    _throwIfCancelled(isCancelled);
    final Uint8List finalizedHeaderBytes = switch (container) {
      Tiff16Container.classic => encodeTiff16Header(
          width: tileStore.width,
          height: tileStore.height,
          rowsPerStrip: rowsPerStrip,
          compression: compression,
          predictor: selectedPredictor,
          stripOffsetsOverride: stripOffsets,
          stripByteCountsOverride: stripByteCounts,
        ).bytes,
      Tiff16Container.bigTiff => encodeBigTiff16Header(
          width: tileStore.width,
          height: tileStore.height,
          rowsPerStrip: rowsPerStrip,
          compression: compression,
          predictor: selectedPredictor,
          stripOffsetsOverride: stripOffsets,
          stripByteCountsOverride: stripByteCounts,
        ).bytes,
    };
    output.setPositionSync(0);
    output.writeFromSync(finalizedHeaderBytes);
    output.flushSync();
    completed = true;
    return file;
  } finally {
    try {
      await output.close();
    } finally {
      if (!completed) {
        try {
          if (await file.exists()) await file.delete();
        } on FileSystemException {
          // Best-effort cleanup of a partial TIFF/BigTIFF output.
        }
      }
    }
  }
}

Future<Tiff16Predictor> _selectTiff16Predictor({
  required LinearRgbTileStore tileStore,
  required AutoToneParameters tone,
  required double baselineExposureEv,
  DngProfileHueSatMap? profileHueSatMap,
  DngProfileLookTable? profileLookTable,
  DngProfileToneCurve? profileToneCurve,
  DngFinalRenderProfile? renderProfile,
  bool Function()? isCancelled,
}) async {
  const int maximumSampleRows = 32;
  final int sampleHeight = math.min(maximumSampleRows, tileStore.height);
  final Set<int> sampleStarts = <int>{
    0,
    math.max(0, (tileStore.height - sampleHeight) ~/ 2),
    math.max(0, tileStore.height - sampleHeight),
  };
  final ZLibEncoder encoder = ZLibEncoder(level: 6);
  int plainBytes = 0;
  int differencedBytes = 0;
  for (final int y in sampleStarts) {
    _throwIfCancelled(isCancelled);
    final LinearRgbTile sample = await tileStore.readRegion(
      x: 0,
      y: y,
      width: tileStore.width,
      height: sampleHeight,
    );
    final Uint16List display = toneMapToDisplayRgb16(
      sample.interleavedRgb,
      exposureScale: tone.exposureScale,
      baselineExposureEv:
          renderProfile?.baselineExposureEv ?? baselineExposureEv,
      whitePoint: tone.whitePoint,
      linearColorTransform: renderProfile?.linearColorTransform,
      postProfileColorTransform: renderProfile?.postProfileColorTransform,
      profileHueSatMap: renderProfile?.hueSatMap ?? profileHueSatMap,
      profileLookTable: renderProfile?.lookTable ?? profileLookTable,
      profileToneCurve: renderProfile?.toneCurve ?? profileToneCurve,
    );
    plainBytes += encoder
        .convert(
          _encodeTiff16Strip(
            display,
            width: tileStore.width,
            predictor: Tiff16Predictor.none,
          ),
        )
        .length;
    differencedBytes += encoder
        .convert(
          _encodeTiff16Strip(
            display,
            width: tileStore.width,
            predictor: Tiff16Predictor.horizontalDifferencing,
          ),
        )
        .length;
  }
  return differencedBytes <= plainBytes
      ? Tiff16Predictor.horizontalDifferencing
      : Tiff16Predictor.none;
}

Uint8List _encodeTiff16Strip(
  Uint16List display, {
  required int width,
  required Tiff16Predictor predictor,
}) {
  final Uint8List encoded = Uint8List(display.length * 2);
  final ByteData encodedData = ByteData.sublistView(encoded);
  for (int index = 0; index < display.length; index++) {
    int value = display[index];
    if (predictor == Tiff16Predictor.horizontalDifferencing) {
      final int pixel = index ~/ 3;
      if (pixel % width != 0) {
        value = (value - display[index - 3]) & 0xffff;
      }
    }
    encodedData.setUint16(index * 2, value, Endian.little);
  }
  return encoded;
}

Future<File> exportTileStoreToImage({
  required LinearRgbTileStore tileStore,
  required String outputPath,
  required OutputImageFormat format,
  double? exposureScale,
  double baselineExposureEv = 0,
  double? whitePoint,
  DngProfileHueSatMap? profileHueSatMap,
  DngProfileLookTable? profileLookTable,
  DngProfileToneCurve? profileToneCurve,
  DngFinalRenderProfile? renderProfile,
  LinearContributionTileStore? contributionStore,
  Uint8List? linearDngTransparencyMask,
  LinearDngTransparencyMaskSource? linearDngTransparencyMaskSource,
  LinearDngCompression linearDngCompression = LinearDngCompression.none,
  bool Function()? isCancelled,
}) async {
  if (Zone.current[nativeOperationStatusPath] != null) {
    await ensureProcessingStorage(
        width: tileStore.width, height: tileStore.height, bytesPerPixel: 26);
  }
  return traceNativeOperation(
      operation: 'finalExport',
      stage: outputPath,
      call: () => switch (format) {
            OutputImageFormat.jpeg => exportTileStoreToJpeg(
                tileStore: tileStore,
                outputPath: outputPath,
                exposureScale: exposureScale,
                baselineExposureEv: baselineExposureEv,
                whitePoint: whitePoint,
                profileHueSatMap: profileHueSatMap,
                profileLookTable: profileLookTable,
                profileToneCurve: profileToneCurve,
                renderProfile: renderProfile,
                isCancelled: isCancelled,
              ),
            OutputImageFormat.bmp8 => exportTileStoreToBmp(
                tileStore: tileStore,
                outputPath: outputPath,
                exposureScale: exposureScale,
                baselineExposureEv: baselineExposureEv,
                whitePoint: whitePoint,
                profileHueSatMap: profileHueSatMap,
                profileLookTable: profileLookTable,
                profileToneCurve: profileToneCurve,
                renderProfile: renderProfile,
                isCancelled: isCancelled,
              ),
            OutputImageFormat.tiff16 => exportTileStoreToTiff16(
                tileStore: tileStore,
                outputPath: outputPath,
                container: recommendedTiff16Container(
                  width: tileStore.width,
                  height: tileStore.height,
                ),
                exposureScale: exposureScale,
                baselineExposureEv: baselineExposureEv,
                whitePoint: whitePoint,
                profileHueSatMap: profileHueSatMap,
                profileLookTable: profileLookTable,
                profileToneCurve: profileToneCurve,
                renderProfile: renderProfile,
                isCancelled: isCancelled,
              ),
            OutputImageFormat.linearDng =>
              _exportLinearDngWithoutRenderedAdjustments(
                tileStore: tileStore,
                outputPath: outputPath,
                exposureScale: exposureScale,
                baselineExposureEv: baselineExposureEv,
                whitePoint: whitePoint,
                profileHueSatMap: profileHueSatMap,
                profileLookTable: profileLookTable,
                profileToneCurve: profileToneCurve,
                renderProfile: renderProfile,
                contributionStore: contributionStore,
                linearDngTransparencyMask: linearDngTransparencyMask,
                linearDngTransparencyMaskSource:
                    linearDngTransparencyMaskSource,
                linearDngCompression: linearDngCompression,
                isCancelled: isCancelled,
              ),
          });
}

Future<File> _exportLinearDngWithoutRenderedAdjustments({
  required LinearRgbTileStore tileStore,
  required String outputPath,
  required double? exposureScale,
  required double baselineExposureEv,
  required double? whitePoint,
  required DngProfileHueSatMap? profileHueSatMap,
  required DngProfileLookTable? profileLookTable,
  required DngProfileToneCurve? profileToneCurve,
  required DngFinalRenderProfile? renderProfile,
  required LinearContributionTileStore? contributionStore,
  required Uint8List? linearDngTransparencyMask,
  required LinearDngTransparencyMaskSource? linearDngTransparencyMaskSource,
  required LinearDngCompression linearDngCompression,
  required bool Function()? isCancelled,
}) async {
  if (exposureScale != null ||
      baselineExposureEv != 0 ||
      whitePoint != null ||
      profileHueSatMap != null ||
      profileLookTable != null ||
      profileToneCurve != null) {
    throw ArgumentError(
      'Linear DNG export does not bake exposure, white point, LUTs, or tone curves.',
    );
  }
  final transform = renderProfile?.linearDngColorTransform;
  if (transform == null) {
    throw ArgumentError(
      'Linear DNG export requires a validated linear-to-sRGB color transform.',
    );
  }
  final int maskSources = (contributionStore != null ? 1 : 0) +
      (linearDngTransparencyMask != null ? 1 : 0) +
      (linearDngTransparencyMaskSource != null ? 1 : 0);
  if (maskSources > 1) {
    throw ArgumentError(
      'Provide only one Linear DNG validity source.',
    );
  }
  final Uint8List? transparencyMask = linearDngTransparencyMask;
  if (transparencyMask != null &&
      transparencyMask.length != tileStore.width * tileStore.height) {
    throw ArgumentError(
      'Linear DNG transparency-mask dimensions do not match output.',
    );
  }
  if (contributionStore != null &&
      (contributionStore.width != tileStore.width ||
          contributionStore.height != tileStore.height)) {
    throw ArgumentError(
      'Contribution-store dimensions do not match Linear DNG output.',
    );
  }
  if (linearDngTransparencyMaskSource != null &&
      (linearDngTransparencyMaskSource.width != tileStore.width ||
          linearDngTransparencyMaskSource.height != tileStore.height)) {
    throw ArgumentError(
      'Transparency-mask source dimensions do not match Linear DNG output.',
    );
  }
  return exportTileStoreToLinearDng(
    tileStore: tileStore,
    outputPath: outputPath,
    inputToLinearSrgb: transform,
    transparencyMask: transparencyMask,
    contributionStore: contributionStore,
    transparencyMaskSource: linearDngTransparencyMaskSource,
    compression: linearDngCompression,
    isCancelled: isCancelled,
  );
}
