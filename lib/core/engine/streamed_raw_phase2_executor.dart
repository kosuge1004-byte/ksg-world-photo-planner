import 'dart:math' as math;
import 'dart:typed_data';

import '../demosaic/demosaic_algorithm.dart';
import '../demosaic/demosaic_engine.dart';
import '../demosaic/demosaic_registry.dart';
import '../demosaic/native_mobile_stack_demosaic_engine_stub.dart'
    if (dart.library.io) '../demosaic/native_mobile_stack_demosaic_engine.dart';
import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../image/raw_saturation_mask.dart';
import '../quality/highest_quality_policy.dart';
import '../raw/file_backed_raw_decode.dart';
import '../raw/raw_decoder_contract.dart';
import '../tiles/overlapped_tile_plan.dart';
import '../tiles/tile_grid.dart';
import 'processing_job.dart';

/// Result of the Work301 memory-bounded RAW path.
final class StreamedRawPhase2Result {
  const StreamedRawPhase2Result({
    required this.tileStore,
    required this.sourceSaturationMask,
    required this.rgbSaturationInfluenceMask,
    required this.metadata,
    required this.cfaPattern,
  });

  final LinearRgbTileStore tileStore;
  final RawSaturationMask? sourceSaturationMask;
  final RawSaturationMask? rgbSaturationInfluenceMask;
  final RawFrameMetadata metadata;
  final CfaPattern cfaPattern;
}

/// Decodes directly to disk, performs the RAW calibration chain in bounded
/// row chunks, then demosaics directly from the calibrated file-backed CFA.
///
/// It intentionally preserves the established arithmetic/order:
/// LinearizationTable -> black subtraction -> master dark -> white-level
/// normalization/clamp -> camera WB -> master flat. Automatic hot/cold-pixel
/// detection is not part of this path; callers must use the established
/// in-memory path when such a defect map is requested.
Future<StreamedRawPhase2Result> runStreamedRawPhase2({
  required ProcessingJob job,
  required RawFileBackedDecoder decoder,
  required RawDecodeRequest decodeRequest,
  required RawFrameMetadata? probedMetadata,
  required void Function(double progress) reportProgress,
  FileBackedLinearRawMosaicStore? masterDarkStore,
  FileBackedLinearRawMosaicStore? masterFlatStore,
  DemosaicRegistry? demosaicRegistry,
  LinearRgbTileStoreFactory? rgbTileStoreFactory,
  HighestQualityPolicy qualityPolicy = const HighestQualityPolicy(),
  TileGrid tileGrid = const TileGrid(),
  int rowChunk = 64,
}) async {
  if (rowChunk <= 0) {
    throw ArgumentError.value(rowChunk, 'rowChunk', 'must be positive');
  }

  job
    ..currentStageId = 'native_raw_stream_decode'
    ..currentStageLabel = 'RAWストリームデコード';
  final FileBackedRawDecode decoded = await FileBackedRawDecode.decode(
    decoder: decoder,
    request: decodeRequest,
  );
  FileBackedLinearRawMosaicStore? calibrated;
  LinearRgbTileStore? rgbStore;
  bool rgbOwnershipTransferred = false;
  try {
    if (job.cancellationRequested) {
      throw const DemosaicProcessingCancelled();
    }
    final RawFrameMetadata merged = mergeSameFrameRawMetadata(
      decoded: decoded.result.metadata,
      probed: probedMetadata,
    );
    _validateStreamingGeometry(decoded, merged);
    _validateCalibrationMetadata(
      metadata: merged,
      width: decoded.result.width,
      height: decoded.result.height,
    );
    job
      ..lastCompletedStageId = job.currentStageId
      ..lastCompletedStageLabel = job.currentStageLabel
      ..currentStageId = 'raw_stream_calibration'
      ..currentStageLabel = 'RAWストリーム較正';

    final StreamedRawCalibrationResult calibratedResult =
        await calibrateStreamedRawToStore(
      input: decoded.store,
      metadata: merged,
      masterDarkStore: masterDarkStore,
      masterFlatStore: masterFlatStore,
      rowChunk: rowChunk,
      isCancelled: () => job.cancellationRequested,
      reportProgress: (double p) => reportProgress(0.05 + 0.38 * p),
    );
    final FileBackedLinearRawMosaicStore calibratedStore =
        calibratedResult.store;
    calibrated = calibratedStore;
    job
      ..lastCompletedStageId = job.currentStageId
      ..lastCompletedStageLabel = job.currentStageLabel
      ..currentStageId = 'demosaic'
      ..currentStageLabel = '高品質デモザイク';

    final RawSaturationMask? sourceMask = calibratedResult.saturationMask;
    final DemosaicRegistry registry = demosaicRegistry ??
        DemosaicRegistry(<DemosaicEngine>[NativeMobileStackDemosaicEngine()]);
    final DemosaicEngine engine = registry.requireProduction(
      DemosaicAlgorithm.mobileStackAdaptive,
    );
    if (engine is! NativeMobileStackDemosaicEngine) {
      throw const DemosaicBackendUnavailable(
        'ストリームRAW経路にはNative file-backedデモザイクが必要です。',
      );
    }
    final LinearRgbTileStoreFactory? factory = rgbTileStoreFactory;
    if (factory == null) {
      throw const LinearRgbTileStoreUnavailable('RGBタイル保存先が接続されていません。');
    }
    final int requestedTileSize = tileGrid.preferredTileWidth;
    final int tileSize = requestedTileSize > 48 ? requestedTileSize : 64;
    final OverlappedTilePlan plan = OverlappedTilePlan.create(
      imageWidth: calibratedStore.width,
      imageHeight: calibratedStore.height,
      tileSize: tileSize,
      overlap: 24,
    );
    final LinearRgbTileStore createdRgbStore = await factory(
      width: calibratedStore.width,
      height: calibratedStore.height,
      plan: plan,
    );
    rgbStore = createdRgbStore;
    _validateEmptyStore(
      calibratedStore.width,
      calibratedStore.height,
      createdRgbStore,
    );
    reportProgress(0.45);
    bool committed = false;
    try {
      for (int index = 0; index < plan.tiles.length; index++) {
        if (job.cancellationRequested) {
          throw const DemosaicProcessingCancelled();
        }
        final OverlappedTile plannedTile = plan.tiles[index];
        final LinearRgbTile tile = await engine.processFileBackedTile(
          store: calibratedStore,
          tile: plannedTile,
          saturationMask: sourceMask,
          qualityPolicy: qualityPolicy,
          isCancelled: () => job.cancellationRequested,
        );
        _validateDemosaicTile(plannedTile, tile);
        await createdRgbStore.writeTile(tile);
        reportProgress(0.45 + 0.54 * (index + 1) / plan.tiles.length);
      }
      await createdRgbStore.commit();
      committed = true;
      job
        ..lastCompletedStageId = job.currentStageId
        ..lastCompletedStageLabel = job.currentStageLabel;
      final RawSaturationMask? influence = sourceMask?.dilatedChebyshev(
        width: calibratedStore.width,
        height: calibratedStore.height,
        radius: engine.requiredInputRadius,
      );
      final LinearRgbTileStore ready = createdRgbStore;
      rgbOwnershipTransferred = true;
      reportProgress(1);
      return StreamedRawPhase2Result(
        tileStore: ready,
        sourceSaturationMask: sourceMask,
        rgbSaturationInfluenceMask: influence,
        metadata: merged,
        cfaPattern: decoded.result.cfaPattern,
      );
    } finally {
      if (!committed) {
        await createdRgbStore.abort();
      }
      if (engine is DisposableDemosaicEngine) {
        (engine as DisposableDemosaicEngine).disposeTransientResources();
      }
    }
  } finally {
    await calibrated?.dispose();
    await decoded.dispose();
    if (!rgbOwnershipTransferred && rgbStore != null) {
      try {
        await rgbStore.dispose();
      } on Object {
        // Preserve the original processing failure.
      }
    }
  }
}

void _validateStreamingGeometry(
  FileBackedRawDecode decoded,
  RawFrameMetadata metadata,
) {
  final area = metadata.activeArea;
  if (metadata.orientation != 1 ||
      area.left != 0 ||
      area.top != 0 ||
      area.width != decoded.result.width ||
      area.height != decoded.result.height) {
    throw const RawDecodeFailure(
      code: RawDecodeErrorCode.unsupportedFormat,
      message: 'ストリームRAW経路は全面ActiveAreaかつOrientation=1のみ対応です。',
    );
  }
}

void _validateCalibrationMetadata({
  required RawFrameMetadata metadata,
  required int width,
  required int height,
}) {
  final List<double> black = metadata.blackLevels;
  if (black.length != 4 ||
      black.any((double v) => !v.isFinite || v < 0) ||
      !metadata.whiteLevel.isFinite ||
      metadata.whiteLevel <= 0 ||
      black.any((double v) => v >= metadata.whiteLevel)) {
    throw const RawDecodeFailure(
      code: RawDecodeErrorCode.corruptData,
      message: 'ストリームRAW較正メタデータのBlack/WhiteLevelが不正です。',
    );
  }
  final List<double>? dh = metadata.blackLevelDeltaH;
  final List<double>? dv = metadata.blackLevelDeltaV;
  if (dh != null && (dh.length != width || dh.any((double v) => !v.isFinite))) {
    throw const RawDecodeFailure(
      code: RawDecodeErrorCode.corruptData,
      message: 'BlackLevelDeltaHの寸法がRAW幅と一致しません。',
    );
  }
  if (dv != null &&
      (dv.length != height || dv.any((double v) => !v.isFinite))) {
    throw const RawDecodeFailure(
      code: RawDecodeErrorCode.corruptData,
      message: 'BlackLevelDeltaVの寸法がRAW高さと一致しません。',
    );
  }
}

final class StreamedRawCalibrationResult {
  const StreamedRawCalibrationResult(this.store, this.saturationMask);
  final FileBackedLinearRawMosaicStore store;
  final RawSaturationMask? saturationMask;
}

Future<StreamedRawCalibrationResult> calibrateStreamedRawToStore({
  required FileBackedLinearRawMosaicStore input,
  required RawFrameMetadata metadata,
  required FileBackedLinearRawMosaicStore? masterDarkStore,
  required FileBackedLinearRawMosaicStore? masterFlatStore,
  required int rowChunk,
  required bool Function() isCancelled,
  required void Function(double progress) reportProgress,
}) async {
  if (masterDarkStore != null) {
    _validateMaster(input, masterDarkStore, 'dark');
  }
  if (masterFlatStore != null) {
    _validateMaster(input, masterFlatStore, 'flat');
  }
  const double maxFloat32 = 3.4028234663852886e38;
  const double minimumFlatValue = 0.05;
  final int width = input.width;
  final int height = input.height;
  final int pixelCount = width * height;
  final double maxBlack = _maximumComputedBlackLevel(
    width: width,
    height: height,
    blackLevels: metadata.blackLevels,
    horizontal: metadata.blackLevelDeltaH,
    vertical: metadata.blackLevelDeltaV,
  );
  if (maxBlack >= metadata.whiteLevel) {
    throw StateError('Computed DNG black level must remain below WhiteLevel.');
  }
  final double whiteScale = 1 / (metadata.whiteLevel - maxBlack);
  final List<double> wb =
      metadata.cameraWhiteBalance ?? const <double>[1, 1, 1, 1];
  if (wb.length != 4 || wb.any((double v) => !v.isFinite || v <= 0)) {
    throw StateError('RAW camera white balance is invalid.');
  }
  final List<double>? table = metadata.linearizationTable;
  final Uint8List packedInvalid = Uint8List((pixelCount + 7) >> 3);
  int invalidCount = 0;

  final FileBackedLinearRawMosaicStore output =
      await FileBackedLinearRawMosaicStore.createTemporary(
    width: width,
    height: height,
    cfaPattern: input.cfaPattern,
  );
  bool committed = false;
  try {
    for (int y = 0; y < height; y += rowChunk) {
      if (isCancelled()) throw const DemosaicProcessingCancelled();
      final int rows = math.min(rowChunk, height - y);
      final Float32List samples = await input.readRegion(
        x: 0,
        y: y,
        width: width,
        height: rows,
      );
      final Float32List? dark = masterDarkStore == null
          ? null
          : await masterDarkStore.readRegion(
              x: 0, y: y, width: width, height: rows);
      final RawSaturationMask? darkInvalid = masterDarkStore == null
          ? null
          : await masterDarkStore.readSaturationRegion(
              x: 0, y: y, width: width, height: rows);
      final Float32List? flat = masterFlatStore == null
          ? null
          : await masterFlatStore.readRegion(
              x: 0, y: y, width: width, height: rows);
      final RawSaturationMask? flatInvalid = masterFlatStore == null
          ? null
          : await masterFlatStore.readSaturationRegion(
              x: 0, y: y, width: width, height: rows);

      for (int local = 0; local < samples.length; local++) {
        final int localY = local ~/ width;
        final int x = local - localY * width;
        final int globalY = y + localY;
        final int globalIndex = globalY * width + x;
        final int phase = ((globalY & 1) << 1) | (x & 1);
        double value = samples[local];
        if (!value.isFinite || value < 0) {
          throw StateError('RAW stored sample is invalid before calibration.');
        }

        // Match the established Phase2 stage boundaries exactly.  Each
        // established stage mutates a Float32List in place, so the next stage
        // consumes the Float32-rounded value rather than the previous Dart
        // double intermediate.
        if (table != null) {
          final int stored = value.round();
          if ((value - stored).abs() > 1e-6) {
            throw StateError(
                'RAW stored sample is not an integer encoding value.');
          }
          final int tableIndex =
              stored < table.length ? stored : table.length - 1;
          value = table[tableIndex];
          samples[local] = value; // LinearizationTable Float32 boundary.
          value = samples[local];
        }

        // The established pipeline rebuilds the immutable source saturation
        // mask immediately after LinearizationTable.  Without a table, this is
        // equivalent to thresholding the already-Float32 stored sample.
        bool invalid = value >= metadata.whiteLevel;

        final double spatialOffset = (metadata.blackLevelDeltaH == null
                ? 0.0
                : metadata.blackLevelDeltaH![x]) +
            (metadata.blackLevelDeltaV == null
                ? 0.0
                : metadata.blackLevelDeltaV![globalY]);
        value = value - metadata.blackLevels[phase] - spatialOffset;
        if (!value.isFinite || value.abs() > maxFloat32) {
          throw StateError('RAW black-level correction exceeded FP32 range.');
        }
        samples[local] = value; // Black-level stage Float32 boundary.
        value = samples[local];

        if (dark != null) {
          final double darkValue = dark[local];
          if (!darkValue.isFinite) {
            throw StateError('Master dark contains a non-finite sample.');
          }
          final bool badDark = darkInvalid?.isSaturatedIndex(local) ?? false;
          if (badDark) {
            invalid = true;
          } else {
            value -= darkValue;
            if (!value.isFinite || value.abs() > maxFloat32) {
              throw StateError('Dark subtraction exceeded FP32 range.');
            }
            samples[local] = value; // Master-dark Float32 boundary.
            value = samples[local];
          }
        }

        value *= whiteScale;
        if (value > 1.0) value = 1.0;
        if (!value.isFinite || value.abs() > maxFloat32) {
          throw StateError('White-level normalization exceeded FP32 range.');
        }
        samples[local] = value; // White-level stage Float32 boundary.
        value = samples[local];

        value *= wb[phase];
        if (!value.isFinite || value.abs() > maxFloat32) {
          throw StateError('Camera white balance exceeded FP32 range.');
        }
        samples[local] = value; // Camera-WB stage Float32 boundary.
        value = samples[local];

        if (flat != null) {
          final double flatValue = flat[local];
          if (!flatValue.isFinite) {
            throw StateError('Master flat contains a non-finite sample.');
          }
          final bool unusableFlat =
              (flatInvalid?.isSaturatedIndex(local) ?? false) ||
                  !(flatValue > minimumFlatValue);
          if (unusableFlat) {
            invalid = true;
          } else {
            value /= flatValue;
            if (!value.isFinite || value.abs() > maxFloat32) {
              throw StateError('Flat correction exceeded FP32 range.');
            }
            samples[local] = value; // Master-flat Float32 boundary.
            value = samples[local];
          }
        }

        // Value is already stored at the final established stage boundary.
        if (invalid) {
          packedInvalid[globalIndex >> 3] |= 1 << (globalIndex & 7);
          invalidCount++;
        }
      }
      await output.writeRows(y: y, rowCount: rows, samples: samples);
      reportProgress((y + rows) / height);
      if (y + rows < height) await Future<void>.delayed(Duration.zero);
    }
    await output.commitRowWrites(
      packedSaturationMask: invalidCount == 0 ? null : packedInvalid,
      hasSaturatedPixels: invalidCount != 0,
    );
    committed = true;
    final RawSaturationMask? mask = invalidCount == 0
        ? null
        : RawSaturationMask.takePackedBytes(
            pixelCount: pixelCount,
            packedBytes: packedInvalid,
            saturatedCount: invalidCount,
          );
    return StreamedRawCalibrationResult(output, mask);
  } finally {
    if (!committed) await output.abort();
  }
}

void _validateMaster(
  FileBackedLinearRawMosaicStore light,
  FileBackedLinearRawMosaicStore master,
  String label,
) {
  if (light.width != master.width || light.height != master.height) {
    throw ArgumentError('Light and master $label dimensions must match.');
  }
  if (light.cfaPattern != master.cfaPattern) {
    throw ArgumentError('Light and master $label CFA patterns must match.');
  }
}

double _maximumComputedBlackLevel({
  required int width,
  required int height,
  required List<double> blackLevels,
  required List<double>? horizontal,
  required List<double>? vertical,
}) {
  final List<double> maxH = _maxDeltaByParity(width, horizontal);
  final List<double> maxV = _maxDeltaByParity(height, vertical);
  double maximum = double.negativeInfinity;
  for (int yp = 0; yp < 2; yp++) {
    for (int xp = 0; xp < 2; xp++) {
      if (!maxH[xp].isFinite || !maxV[yp].isFinite) continue;
      final int phase = (yp << 1) | xp;
      final double value = blackLevels[phase] + maxH[xp] + maxV[yp];
      if (!value.isFinite) {
        throw StateError('Computed DNG black level is not finite.');
      }
      if (value > maximum) maximum = value;
    }
  }
  if (!maximum.isFinite) {
    throw StateError('Computed DNG black level is invalid.');
  }
  return maximum;
}

List<double> _maxDeltaByParity(int length, List<double>? values) {
  final List<double> result = <double>[
    double.negativeInfinity,
    double.negativeInfinity
  ];
  for (int i = 0; i < length; i++) {
    final double value = values == null ? 0.0 : values[i];
    if (!value.isFinite) {
      throw StateError('DNG black-level delta is not finite.');
    }
    final int phase = i & 1;
    if (value > result[phase]) result[phase] = value;
  }
  return result;
}

void _validateEmptyStore(int width, int height, LinearRgbTileStore store) {
  if (store.width != width ||
      store.height != height ||
      store.completedTileCount != 0 ||
      store.isCommitted) {
    throw StateError('RGB tile store is not a fresh store for this frame.');
  }
}

void _validateDemosaicTile(OverlappedTile planned, LinearRgbTile actual) {
  if (actual.x != planned.outputX ||
      actual.y != planned.outputY ||
      actual.width != planned.outputWidth ||
      actual.height != planned.outputHeight) {
    throw StateError('Demosaic output tile does not match requested region.');
  }
  if (actual.interleavedRgb.any((double value) => !value.isFinite)) {
    throw StateError('Demosaic output tile contains a non-finite value.');
  }
}
