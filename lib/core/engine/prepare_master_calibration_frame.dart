import 'dart:io';
import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/raw_saturation_mask.dart';
import '../pipeline/dark_frame_subtraction.dart';
import '../pipeline/flat_field_calibration.dart';
import '../pipeline/raw_mosaic_calibrator.dart';
import '../raw/raw_decoder_contract.dart';
import '../raw/raw_decoder_registry.dart';
import '../raw/raw_file_probe.dart';
import '../raw/raw_metadata_probe.dart';
import '../raw/raw_probe_result.dart';

/// Decodes and prepares a set of dark or flat calibration RAW files into
/// the master frame `dark_frame_subtraction.dart`'s `computeMasterDark`
/// (Work96) / `flat_field_calibration.dart`'s `computeMasterFlat`
/// (Work98) expect, closing the last real gap those two modules left
/// open: they always assumed a caller already had a properly-prepared
/// [LinearRawMosaic] set in hand, with no code anywhere to actually
/// *produce* one from real RAW calibration-frame files.
///
/// Deliberately **not** built on `runRawMosaicCalibrationJob`'s
/// (Work89) full calibration pipeline: that pipeline applies black-
/// level subtraction, white-level normalization, camera white balance,
/// *and* defect-pixel correction, in that order — the right chain for a
/// light frame that is about to be registered/combined. A calibration
/// frame's own preparation needs to stop *earlier*: `dark_frame_
/// subtraction.dart`'s own doc comment specifies a master dark should
/// represent "signal above the black level, from dark current alone",
/// meaning the calibration frame must be brought into the same linear sensor
/// domain as the light frame immediately before dark/flat correction: optional
/// DNG LinearizationTable first, then the full computed black level
/// (BlackLevel + BlackLevelDeltaH/V). White-level normalization and camera
/// white-balance gains are deliberately left out because they belong after
/// additive dark subtraction in the light-frame pipeline.
///
/// This file has not been executed against the Dart SDK. Its own new
/// logic — decoding a batch of files and stopping calibration at the
/// right stage — has direct test coverage in `test/prepare_master_
/// calibration_frame_test.dart`, reusing the same fake-decoder pattern
/// `raw_mosaic_calibration_job_executor_test.dart` (Work89) already
/// established.

/// Decodes every file in [sourcePaths], applies DNG linearization when
/// present and then the full black-level subtraction, and combines the
/// results into one master dark frame via
/// `computeMasterDark`.
///
/// Throws if any file fails to probe or decode, or (from
/// `computeMasterDark` itself) if [sourcePaths] is empty or the decoded
/// mosaics have mismatched dimensions or CFA patterns — a calibration-
/// frame batch failing partway through is treated as a hard error here,
/// unlike light-frame decoding (`runCfaDrizzleMilkyWayPipeline`,
/// Work90's own tolerant per-frame failure handling): a silently-
/// incomplete calibration frame set would corrupt every light frame it
/// is later applied to, not just itself, so this function does not
/// attempt to carry on with a partial batch.
Future<LinearRawMosaic> prepareMasterDark({
  required List<String> sourcePaths,
  required RawDecoderRegistry decoderRegistry,
  RawFileProbe probe = const RawFileProbe(),
  RawMetadataProbe? metadataProbe,
  RawMosaicCalibrator calibrator = const RawMosaicCalibrator(),
}) async {
  if (sourcePaths.isEmpty) {
    throw InvalidDarkFrameInput('At least one dark frame is required.');
  }
  final List<FileBackedLinearRawMosaicStore> stores =
      <FileBackedLinearRawMosaicStore>[];
  try {
    await _decodeCalibrationFramesToStores(
      sourcePaths: sourcePaths,
      decoderRegistry: decoderRegistry,
      probe: probe,
      metadataProbe: metadataProbe,
      calibrator: calibrator,
      stores: stores,
    );
    return await _combineMasterDarkFromStores(stores);
  } finally {
    for (final FileBackedLinearRawMosaicStore store in stores.reversed) {
      try {
        await store.dispose();
      } on Object {
        // Best-effort cleanup must not hide the calibration result/error.
      }
    }
  }
}

/// Memory-bounded master-flat preparation. Calibration RAWs are decoded and
/// calibrated one at a time, immediately persisted to temporary Float32
/// stores, then combined in row chunks. This preserves the same per-pixel
/// median and per-CFA-plane normalization as [computeMasterFlat] without
/// retaining every decoded calibration frame in RAM simultaneously.
Future<LinearRawMosaic> prepareMasterFlat({
  required List<String> sourcePaths,
  required RawDecoderRegistry decoderRegistry,
  RawFileProbe probe = const RawFileProbe(),
  RawMetadataProbe? metadataProbe,
  RawMosaicCalibrator calibrator = const RawMosaicCalibrator(),
  LinearRawMosaic? darkToSubtract,
}) async {
  if (sourcePaths.isEmpty) {
    throw InvalidFlatFrameInput('At least one flat frame is required.');
  }
  final List<FileBackedLinearRawMosaicStore> stores =
      <FileBackedLinearRawMosaicStore>[];
  try {
    await _decodeCalibrationFramesToStores(
      sourcePaths: sourcePaths,
      decoderRegistry: decoderRegistry,
      probe: probe,
      metadataProbe: metadataProbe,
      calibrator: calibrator,
      darkToSubtract: darkToSubtract,
      stores: stores,
    );
    return await _combineMasterFlatFromStores(stores);
  } finally {
    for (final FileBackedLinearRawMosaicStore store in stores.reversed) {
      try {
        await store.dispose();
      } on Object {
        // Best-effort cleanup must not hide the calibration result/error.
      }
    }
  }
}

/// Prepares a master dark directly into a temporary file-backed RAW store.
/// Work296 writes bounded row chunks as the median combine proceeds, so no
/// complete final-master Float32 sample plane is materialized in RAM.
Future<FileBackedLinearRawMosaicStore> prepareMasterDarkStore({
  required List<String> sourcePaths,
  required RawDecoderRegistry decoderRegistry,
  RawFileProbe probe = const RawFileProbe(),
  RawMetadataProbe? metadataProbe,
  RawMosaicCalibrator calibrator = const RawMosaicCalibrator(),
}) async {
  if (sourcePaths.isEmpty) {
    throw InvalidDarkFrameInput('At least one dark frame is required.');
  }
  final List<FileBackedLinearRawMosaicStore> stores =
      <FileBackedLinearRawMosaicStore>[];
  try {
    await _decodeCalibrationFramesToStores(
      sourcePaths: sourcePaths,
      decoderRegistry: decoderRegistry,
      probe: probe,
      metadataProbe: metadataProbe,
      calibrator: calibrator,
      stores: stores,
    );
    return await _combineMasterDarkStoresToStore(stores);
  } finally {
    for (final FileBackedLinearRawMosaicStore store in stores.reversed) {
      try {
        await store.dispose();
      } on Object {
        // Best-effort cleanup must not hide the calibration result/error.
      }
    }
  }
}

/// File-backed counterpart to [prepareMasterFlat].
///
/// When [darkStoreToSubtract] is supplied, each flat RAW is dark-subtracted
/// directly from the file-backed master dark in bounded row chunks. This
/// avoids materializing a second full master-dark plane merely to build the
/// master flat.
Future<FileBackedLinearRawMosaicStore> prepareMasterFlatStore({
  required List<String> sourcePaths,
  required RawDecoderRegistry decoderRegistry,
  RawFileProbe probe = const RawFileProbe(),
  RawMetadataProbe? metadataProbe,
  RawMosaicCalibrator calibrator = const RawMosaicCalibrator(),
  LinearRawMosaic? darkToSubtract,
  FileBackedLinearRawMosaicStore? darkStoreToSubtract,
}) async {
  if (darkToSubtract != null && darkStoreToSubtract != null) {
    throw ArgumentError(
      'Supply either darkToSubtract or darkStoreToSubtract, not both.',
    );
  }
  if (sourcePaths.isEmpty) {
    throw InvalidFlatFrameInput('At least one flat frame is required.');
  }
  final List<FileBackedLinearRawMosaicStore> stores =
      <FileBackedLinearRawMosaicStore>[];
  try {
    await _decodeCalibrationFramesToStores(
      sourcePaths: sourcePaths,
      decoderRegistry: decoderRegistry,
      probe: probe,
      metadataProbe: metadataProbe,
      calibrator: calibrator,
      darkToSubtract: darkToSubtract,
      darkStoreToSubtract: darkStoreToSubtract,
      stores: stores,
    );
    return await _combineMasterFlatStoresToStore(stores);
  } finally {
    for (final FileBackedLinearRawMosaicStore store in stores.reversed) {
      try {
        await store.dispose();
      } on Object {
        // Best-effort cleanup must not hide the calibration result/error.
      }
    }
  }
}

const int _masterCombineRowChunk = 64;

Future<FileBackedLinearRawMosaicStore> _combineMasterDarkStoresToStore(
  List<FileBackedLinearRawMosaicStore> stores,
) async {
  final FileBackedLinearRawMosaicStore first = stores.first;
  final int width = first.width;
  final int height = first.height;
  final int pixelCount = width * height;
  final Uint8List packedInvalid = Uint8List((pixelCount + 7) >> 3);
  int invalidCount = 0;
  final List<double> columnBuffer = List<double>.filled(stores.length, 0);
  final FileBackedLinearRawMosaicStore output =
      await FileBackedLinearRawMosaicStore.createTemporary(
    width: width,
    height: height,
    cfaPattern: first.cfaPattern,
  );
  try {
    for (int y = 0; y < height; y += _masterCombineRowChunk) {
      final int rows = (height - y) < _masterCombineRowChunk
          ? height - y
          : _masterCombineRowChunk;
      final List<Float32List> samples = <Float32List>[];
      final List<RawSaturationMask?> masks = <RawSaturationMask?>[];
      for (final FileBackedLinearRawMosaicStore store in stores) {
        samples.add(
            await store.readRegion(x: 0, y: y, width: width, height: rows));
        masks.add(await store.readSaturationRegion(
          x: 0,
          y: y,
          width: width,
          height: rows,
        ));
      }
      final int chunkPixels = width * rows;
      final Float32List chunk = Float32List(chunkPixels);
      for (int local = 0; local < chunkPixels; local++) {
        int validCount = 0;
        for (int frame = 0; frame < stores.length; frame++) {
          if (masks[frame]?.isSaturatedIndex(local) ?? false) continue;
          columnBuffer[validCount++] = samples[frame][local];
        }
        final int pixel = y * width + local;
        if (validCount == 0) {
          chunk[local] = 0;
          packedInvalid[pixel >> 3] |= 1 << (pixel & 7);
          invalidCount++;
          continue;
        }
        final List<double> sorted =
            List<double>.of(columnBuffer.take(validCount))..sort();
        final int middle = validCount >> 1;
        chunk[local] = validCount.isOdd
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2;
      }
      await output.writeRows(y: y, rowCount: rows, samples: chunk);
    }
    await output.commitRowWrites(
      packedSaturationMask: invalidCount == 0 ? null : packedInvalid,
      hasSaturatedPixels: invalidCount != 0,
    );
    return output;
  } catch (_) {
    await output.dispose();
    rethrow;
  }
}

Future<FileBackedLinearRawMosaicStore> _combineMasterFlatStoresToStore(
  List<FileBackedLinearRawMosaicStore> stores,
) async {
  final FileBackedLinearRawMosaicStore first = stores.first;
  final int width = first.width;
  final int height = first.height;
  final int pixelCount = width * height;
  final Uint8List packedInvalid = Uint8List((pixelCount + 7) >> 3);
  int invalidCount = 0;
  final Float64List colorSums = Float64List(3);
  final Uint32List colorCounts = Uint32List(3);
  final List<double> columnBuffer = List<double>.filled(stores.length, 0);
  final Directory tempDirectory = await Directory.systemTemp
      .createTemp('mobile-stack-master-flat-streamed-');
  final File medianFile = File(
    '${tempDirectory.path}${Platform.pathSeparator}median.f64',
  );
  final FileBackedLinearRawMosaicStore output =
      await FileBackedLinearRawMosaicStore.createTemporary(
    width: width,
    height: height,
    cfaPattern: first.cfaPattern,
  );
  RandomAccessFile? medianHandle;
  try {
    medianHandle = await medianFile.open(mode: FileMode.write);
    await medianHandle.truncate(pixelCount * Float64List.bytesPerElement);
    for (int y = 0; y < height; y += _masterCombineRowChunk) {
      final int rows = (height - y) < _masterCombineRowChunk
          ? height - y
          : _masterCombineRowChunk;
      final List<Float32List> samples = <Float32List>[];
      final List<RawSaturationMask?> masks = <RawSaturationMask?>[];
      for (final FileBackedLinearRawMosaicStore store in stores) {
        samples.add(
            await store.readRegion(x: 0, y: y, width: width, height: rows));
        masks.add(await store.readSaturationRegion(
          x: 0,
          y: y,
          width: width,
          height: rows,
        ));
      }
      final int chunkPixels = width * rows;
      final Float64List medians = Float64List(chunkPixels);
      for (int local = 0; local < chunkPixels; local++) {
        int validCount = 0;
        for (int frame = 0; frame < stores.length; frame++) {
          if (masks[frame]?.isSaturatedIndex(local) ?? false) continue;
          columnBuffer[validCount++] = samples[frame][local];
        }
        final int pixel = y * width + local;
        final int absoluteY = pixel ~/ width;
        final int absoluteX = pixel - absoluteY * width;
        if (validCount == 0) {
          medians[local] = 1;
          packedInvalid[pixel >> 3] |= 1 << (pixel & 7);
          invalidCount++;
          continue;
        }
        final List<double> sorted =
            List<double>.of(columnBuffer.take(validCount))..sort();
        final int middle = validCount >> 1;
        final double value = validCount.isOdd
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2;
        if (!value.isFinite) {
          throw InvalidFlatFrameInput(
            'Combined flat frame contains a non-finite sample.',
          );
        }
        medians[local] = value;
        final int color =
            switch (first.cfaPattern.colorAt(absoluteX, absoluteY)) {
          CfaColor.red => 0,
          CfaColor.green => 1,
          CfaColor.blue => 2,
        };
        colorSums[color] += value;
        colorCounts[color]++;
      }
      medianHandle.setPositionSync(y * width * Float64List.bytesPerElement);
      medianHandle.writeFromSync(medians.buffer.asUint8List());
    }
    await medianHandle.flush();

    final Float64List colorMeans = Float64List(3);
    for (int color = 0; color < 3; color++) {
      if (colorCounts[color] == 0) continue;
      final double mean = colorSums[color] / colorCounts[color];
      if (!mean.isFinite || !(mean > 0)) {
        throw InvalidFlatFrameInput(
          'Combined flat CFA color plane has no positive finite signal to normalize against.',
        );
      }
      colorMeans[color] = mean;
    }

    await medianHandle.close();
    medianHandle = await medianFile.open(mode: FileMode.read);
    for (int y = 0; y < height; y += _masterCombineRowChunk) {
      final int rows = (height - y) < _masterCombineRowChunk
          ? height - y
          : _masterCombineRowChunk;
      final int chunkPixels = width * rows;
      final Float64List medians = Float64List(chunkPixels);
      final Uint8List medianBytes = medians.buffer.asUint8List();
      medianHandle.setPositionSync(y * width * Float64List.bytesPerElement);
      final int expectedBytes = medianBytes.length;
      final int read = medianHandle.readIntoSync(medianBytes);
      if (read != expectedBytes) {
        throw StateError('Temporary master-flat median store is incomplete.');
      }
      final Float32List chunk = Float32List(chunkPixels);
      for (int local = 0; local < chunkPixels; local++) {
        final int pixel = y * width + local;
        if ((packedInvalid[pixel >> 3] & (1 << (pixel & 7))) != 0) {
          chunk[local] = 1;
          continue;
        }
        final int absoluteY = pixel ~/ width;
        final int absoluteX = pixel - absoluteY * width;
        final int color =
            switch (first.cfaPattern.colorAt(absoluteX, absoluteY)) {
          CfaColor.red => 0,
          CfaColor.green => 1,
          CfaColor.blue => 2,
        };
        chunk[local] = medians[local] / colorMeans[color];
      }
      await output.writeRows(y: y, rowCount: rows, samples: chunk);
    }
    await output.commitRowWrites(
      packedSaturationMask: invalidCount == 0 ? null : packedInvalid,
      hasSaturatedPixels: invalidCount != 0,
    );
    return output;
  } catch (_) {
    await output.dispose();
    rethrow;
  } finally {
    try {
      await medianHandle?.close();
    } on Object {
      // best effort
    }
    if (await tempDirectory.exists()) {
      await tempDirectory.delete(recursive: true);
    }
  }
}

Future<void> _decodeCalibrationFramesToStores({
  required List<String> sourcePaths,
  required RawDecoderRegistry decoderRegistry,
  required RawFileProbe probe,
  RawMetadataProbe? metadataProbe,
  required RawMosaicCalibrator calibrator,
  LinearRawMosaic? darkToSubtract,
  FileBackedLinearRawMosaicStore? darkStoreToSubtract,
  required List<FileBackedLinearRawMosaicStore> stores,
}) async {
  int? expectedWidth;
  int? expectedHeight;
  CfaPattern? expectedCfa;
  for (final String sourcePath in sourcePaths) {
    LinearRawMosaic mosaic = await _decodeAndSubtractBlackLevel(
      sourcePath: sourcePath,
      decoderRegistry: decoderRegistry,
      probe: probe,
      metadataProbe: metadataProbe,
      calibrator: calibrator,
      darkToSubtract: darkToSubtract,
    );
    if (darkStoreToSubtract != null) {
      mosaic = await subtractDarkFrameFromStoreInPlace(
        mosaic,
        darkStoreToSubtract,
      );
    }
    expectedWidth ??= mosaic.width;
    expectedHeight ??= mosaic.height;
    expectedCfa ??= mosaic.cfaPattern;
    if (mosaic.width != expectedWidth || mosaic.height != expectedHeight) {
      throw ArgumentError(
          'All calibration frames must share the same dimensions.');
    }
    if (mosaic.cfaPattern != expectedCfa) {
      throw ArgumentError(
          'All calibration frames must share the same CFA pattern.');
    }
    final FileBackedLinearRawMosaicStore store =
        await FileBackedLinearRawMosaicStore.createTemporary(
      width: mosaic.width,
      height: mosaic.height,
      cfaPattern: mosaic.cfaPattern,
    );
    try {
      await store.writeFull(mosaic);
      stores.add(store);
    } catch (_) {
      await store.dispose();
      rethrow;
    }
    // `mosaic` intentionally leaves scope here before the next RAW is decoded.
    // Work291's native-owned sample plane can therefore become collectible
    // instead of N complete calibration mosaics remaining strongly reachable.
  }
}

Future<LinearRawMosaic> _combineMasterDarkFromStores(
  List<FileBackedLinearRawMosaicStore> stores,
) async {
  final FileBackedLinearRawMosaicStore first = stores.first;
  final int width = first.width;
  final int height = first.height;
  final int pixelCount = width * height;
  final Float32List master = Float32List(pixelCount);
  final Uint8List packedInvalid = Uint8List((pixelCount + 7) >> 3);
  int invalidCount = 0;
  final List<double> columnBuffer = List<double>.filled(stores.length, 0);

  for (int y = 0; y < height; y += _masterCombineRowChunk) {
    final int rows = (height - y) < _masterCombineRowChunk
        ? height - y
        : _masterCombineRowChunk;
    final List<Float32List> samples = <Float32List>[];
    final List<RawSaturationMask?> masks = <RawSaturationMask?>[];
    for (final FileBackedLinearRawMosaicStore store in stores) {
      samples
          .add(await store.readRegion(x: 0, y: y, width: width, height: rows));
      masks.add(await store.readSaturationRegion(
        x: 0,
        y: y,
        width: width,
        height: rows,
      ));
    }
    final int chunkPixels = width * rows;
    for (int local = 0; local < chunkPixels; local++) {
      int validCount = 0;
      for (int frame = 0; frame < stores.length; frame++) {
        if (masks[frame]?.isSaturatedIndex(local) ?? false) continue;
        columnBuffer[validCount++] = samples[frame][local];
      }
      final int pixel = y * width + local;
      if (validCount == 0) {
        master[pixel] = 0;
        packedInvalid[pixel >> 3] |= 1 << (pixel & 7);
        invalidCount++;
        continue;
      }
      final List<double> sorted = List<double>.of(columnBuffer.take(validCount))
        ..sort();
      final int middle = validCount >> 1;
      master[pixel] = validCount.isOdd
          ? sorted[middle]
          : (sorted[middle - 1] + sorted[middle]) / 2;
    }
  }
  final RawSaturationMask? invalidMask = invalidCount == 0
      ? null
      : RawSaturationMask.takePackedBytes(
          pixelCount: pixelCount,
          packedBytes: packedInvalid,
          saturatedCount: invalidCount,
        );
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: first.cfaPattern,
    samples: master,
    saturationMask: invalidMask,
  );
}

Future<LinearRawMosaic> _combineMasterFlatFromStores(
  List<FileBackedLinearRawMosaicStore> stores,
) async {
  final FileBackedLinearRawMosaicStore first = stores.first;
  final int width = first.width;
  final int height = first.height;
  final int pixelCount = width * height;
  final Uint8List packedInvalid = Uint8List((pixelCount + 7) >> 3);
  int invalidCount = 0;
  final Float64List colorSums = Float64List(3);
  final Uint32List colorCounts = Uint32List(3);
  final List<double> columnBuffer = List<double>.filled(stores.length, 0);
  final Directory tempDirectory =
      await Directory.systemTemp.createTemp('mobile-stack-master-flat-');
  final File medianFile = File(
    '${tempDirectory.path}${Platform.pathSeparator}median.f64',
  );
  RandomAccessFile? medianHandle;
  try {
    medianHandle = await medianFile.open(mode: FileMode.write);
    await medianHandle.truncate(pixelCount * Float64List.bytesPerElement);

    for (int y = 0; y < height; y += _masterCombineRowChunk) {
      final int rows = (height - y) < _masterCombineRowChunk
          ? height - y
          : _masterCombineRowChunk;
      final List<Float32List> samples = <Float32List>[];
      final List<RawSaturationMask?> masks = <RawSaturationMask?>[];
      for (final FileBackedLinearRawMosaicStore store in stores) {
        samples.add(
            await store.readRegion(x: 0, y: y, width: width, height: rows));
        masks.add(await store.readSaturationRegion(
          x: 0,
          y: y,
          width: width,
          height: rows,
        ));
      }
      final int chunkPixels = width * rows;
      final Float64List medians = Float64List(chunkPixels);
      for (int local = 0; local < chunkPixels; local++) {
        int validCount = 0;
        for (int frame = 0; frame < stores.length; frame++) {
          if (masks[frame]?.isSaturatedIndex(local) ?? false) continue;
          columnBuffer[validCount++] = samples[frame][local];
        }
        final int pixel = y * width + local;
        final int absoluteY = pixel ~/ width;
        final int absoluteX = pixel - absoluteY * width;
        if (validCount == 0) {
          medians[local] = 1;
          packedInvalid[pixel >> 3] |= 1 << (pixel & 7);
          invalidCount++;
          continue;
        }
        final List<double> sorted =
            List<double>.of(columnBuffer.take(validCount))..sort();
        final int middle = validCount >> 1;
        final double value = validCount.isOdd
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2;
        if (!value.isFinite) {
          throw InvalidFlatFrameInput(
            'Combined flat frame contains a non-finite sample.',
          );
        }
        medians[local] = value;
        final int color =
            switch (first.cfaPattern.colorAt(absoluteX, absoluteY)) {
          CfaColor.red => 0,
          CfaColor.green => 1,
          CfaColor.blue => 2,
        };
        colorSums[color] += value;
        colorCounts[color]++;
      }
      medianHandle.setPositionSync(y * width * Float64List.bytesPerElement);
      medianHandle.writeFromSync(medians.buffer.asUint8List());
    }
    await medianHandle.flush();

    final Float64List colorMeans = Float64List(3);
    for (int color = 0; color < 3; color++) {
      if (colorCounts[color] == 0) continue;
      final double mean = colorSums[color] / colorCounts[color];
      if (!mean.isFinite || !(mean > 0)) {
        throw InvalidFlatFrameInput(
          'Combined flat CFA color plane has no positive finite signal to normalize against.',
        );
      }
      colorMeans[color] = mean;
    }

    await medianHandle.close();
    medianHandle = await medianFile.open(mode: FileMode.read);
    final Float32List master = Float32List(pixelCount);
    for (int y = 0; y < height; y += _masterCombineRowChunk) {
      final int rows = (height - y) < _masterCombineRowChunk
          ? height - y
          : _masterCombineRowChunk;
      final int chunkPixels = width * rows;
      final Float64List medians = Float64List(chunkPixels);
      final Uint8List medianBytes = medians.buffer.asUint8List();
      medianHandle.setPositionSync(y * width * Float64List.bytesPerElement);
      final int expectedBytes = medianBytes.length;
      final int read = medianHandle.readIntoSync(medianBytes);
      if (read != expectedBytes) {
        throw StateError('Temporary master-flat median store is incomplete.');
      }
      for (int local = 0; local < chunkPixels; local++) {
        final int pixel = y * width + local;
        if ((packedInvalid[pixel >> 3] & (1 << (pixel & 7))) != 0) {
          master[pixel] = 1;
          continue;
        }
        final int absoluteY = pixel ~/ width;
        final int absoluteX = pixel - absoluteY * width;
        final int color =
            switch (first.cfaPattern.colorAt(absoluteX, absoluteY)) {
          CfaColor.red => 0,
          CfaColor.green => 1,
          CfaColor.blue => 2,
        };
        master[pixel] = medians[local] / colorMeans[color];
      }
    }
    final RawSaturationMask? invalidMask = invalidCount == 0
        ? null
        : RawSaturationMask.takePackedBytes(
            pixelCount: pixelCount,
            packedBytes: packedInvalid,
            saturatedCount: invalidCount,
          );
    return LinearRawMosaic(
      width: width,
      height: height,
      cfaPattern: first.cfaPattern,
      samples: master,
      saturationMask: invalidMask,
    );
  } finally {
    try {
      await medianHandle?.close();
    } on Object {
      // best effort
    }
    if (await tempDirectory.exists()) {
      await tempDirectory.delete(recursive: true);
    }
  }
}

Future<LinearRawMosaic> _decodeAndSubtractBlackLevel({
  required String sourcePath,
  required RawDecoderRegistry decoderRegistry,
  required RawFileProbe probe,
  RawMetadataProbe? metadataProbe,
  required RawMosaicCalibrator calibrator,
  LinearRawMosaic? darkToSubtract,
}) async {
  final RawProbeResult probed = await probe.probe(sourcePath);
  if (!probed.isAccepted) {
    throw StateError(
      probed.warning ?? '較正用RAWファイルの入力検証に失敗しました: $sourcePath',
    );
  }
  final RawDecoder decoder = decoderRegistry.requireDecoder(probed.format);
  RawFrameMetadata? probedMetadata;
  if (metadataProbe != null && metadataProbe.supports(probed.format)) {
    probedMetadata = (await metadataProbe.probe(probed)).metadata;
  }
  final RawDecodeResult decoded = await decoder.decode(
    RawDecodeRequest(probe: probed),
  );
  final RawFrameMetadata metadata = mergeSameFrameRawMetadata(
    decoded: decoded.metadata,
    probed: probedMetadata,
  );

  // Calibration frames must enter dark/flat construction in exactly the same
  // linear sensor domain as light frames at the subtraction/division point.
  // Applying only the repeated BlackLevel while lights also apply a DNG
  // LinearizationTable and BlackLevelDeltaH/V makes the master calibration
  // frame numerically incompatible with the light it is intended to correct.
  final List<double>? linearization = metadata.linearizationTable;
  if (linearization != null) {
    final bool completed = await calibrator.applyLinearizationTable(
      decoded.mosaic,
      table: linearization,
    );
    if (!completed) {
      throw StateError('Calibration RAW linearization did not complete.');
    }
  }
  final bool blackCompleted = await calibrator.subtractBlackLevels(
    decoded.mosaic,
    blackLevels: metadata.blackLevels,
    patternOriginX: metadata.activeArea.left,
    patternOriginY: metadata.activeArea.top,
    blackLevelDeltaH: metadata.blackLevelDeltaH,
    blackLevelDeltaV: metadata.blackLevelDeltaV,
  );
  if (!blackCompleted) {
    throw StateError(
        'Calibration RAW black-level subtraction did not complete.');
  }
  if (darkToSubtract == null) return decoded.mosaic;
  return subtractDarkFrameInPlace(decoded.mosaic, darkToSubtract);
}
