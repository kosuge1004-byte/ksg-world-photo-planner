import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import '../registration/luminance_plane.dart';
import 'focus_measure.dart';

final class HighPrecisionFocusMarking {
  HighPrecisionFocusMarking({
    required this.width,
    required this.height,
    required this.frameCount,
    required Float32List confidence,
    required List<Uint8List> frameMasks,
    required List<double> coverageFractions,
  })  : confidence = confidence,
        frameMasks = List<Uint8List>.unmodifiable(frameMasks),
        coverageFractions = List<double>.unmodifiable(coverageFractions) {
    final int pixels = width * height;
    if (width <= 0 ||
        height <= 0 ||
        frameCount < 2 ||
        (confidence.isNotEmpty && confidence.length != pixels) ||
        this.frameMasks.length != frameCount ||
        this.coverageFractions.length != frameCount) {
      throw ArgumentError(
          'High-precision marking dimensions are inconsistent.');
    }
    for (final Uint8List mask in this.frameMasks) {
      if (mask.length != pixels) {
        throw ArgumentError('Focus marking mask length mismatch.');
      }
    }
    for (final double value in this.coverageFractions) {
      if (!value.isFinite || value < 0 || value > 1) {
        throw ArgumentError('Coverage fractions must be finite in [0,1].');
      }
    }
  }

  final int width;
  final int height;
  final int frameCount;
  final Float32List confidence;
  final List<Uint8List> frameMasks;
  final List<double> coverageFractions;
}

HighPrecisionFocusMarking buildHighPrecisionFocusMarking({
  required List<LuminancePlane> alignedLuminance,
  List<Uint8List?>? validMasks,
  List<int> supportRadii = const <int>[1, 2, 4],
  double minimumMarkConfidence = 0.18,
  double acceptableBestScoreRatio = 0.88,
}) {
  if (alignedLuminance.length < 2 ||
      supportRadii.length < 3 ||
      !minimumMarkConfidence.isFinite ||
      minimumMarkConfidence < 0 ||
      minimumMarkConfidence > 1 ||
      !acceptableBestScoreRatio.isFinite ||
      acceptableBestScoreRatio <= 0 ||
      acceptableBestScoreRatio > 1) {
    throw ArgumentError('Invalid high-precision focus marking input.');
  }
  final int width = alignedLuminance.first.width;
  final int height = alignedLuminance.first.height;
  for (final LuminancePlane plane in alignedLuminance) {
    if (plane.width != width || plane.height != height) {
      throw ArgumentError(
          'All marking luminance planes must share dimensions.');
    }
  }
  final List<Uint8List?> masks =
      validMasks ?? List<Uint8List?>.filled(alignedLuminance.length, null);
  if (masks.length != alignedLuminance.length) {
    throw ArgumentError('Marking coverage mask count mismatch.');
  }

  final List<Float32List> combined = <Float32List>[];
  for (int frame = 0; frame < alignedLuminance.length; frame++) {
    combined.add(
      buildHighPrecisionFocusFrameScore(
        alignedLuminance: alignedLuminance[frame],
        validMask: masks[frame],
        supportRadii: supportRadii,
      ),
    );
  }
  return buildHighPrecisionFocusMarkingFromScores(
    width: width,
    height: height,
    combinedScores: combined,
    validMasks: masks,
    minimumMarkConfidence: minimumMarkConfidence,
    acceptableBestScoreRatio: acceptableBestScoreRatio,
  );
}

/// Builds one frame's exact multi-scale marking score so callers can release
/// its full-resolution luminance plane before processing the next frame.
Float32List buildHighPrecisionFocusFrameScore({
  required LuminancePlane alignedLuminance,
  Uint8List? validMask,
  List<int> supportRadii = const <int>[1, 2, 4],
}) {
  if (supportRadii.length < 3) {
    throw ArgumentError('At least three focus support radii are required.');
  }
  final int pixels = alignedLuminance.width * alignedLuminance.height;
  if (validMask != null && validMask.length != pixels) {
    throw ArgumentError('Marking coverage mask length mismatch.');
  }
  final List<FocusMeasurePlane> scales = <FocusMeasurePlane>[
    for (final int radius in supportRadii)
      modifiedLaplacianFocusMeasure(
        alignedLuminance,
        supportRadius: radius,
        validMask: validMask,
      ),
  ];
  final List<double> floors = <double>[
    for (final FocusMeasurePlane scale in scales)
      _robustPositiveNoiseFloor(scale.scores),
  ];
  final Float32List score = Float32List(pixels);
  final Float64List normalized = Float64List(scales.length);

  for (int pixel = 0; pixel < pixels; pixel++) {
    if (validMask != null && validMask[pixel] == 0) continue;
    int normalizedCount = 0;
    for (int scale = 0; scale < scales.length; scale++) {
      final double raw = scales[scale].scores[pixel];
      final double floor = floors[scale];
      final double value = floor > 0 ? raw / floor : raw;
      if (value.isFinite && value > 0) {
        normalized[normalizedCount++] = value;
      }
    }
    if (normalizedCount < 2) continue;
    final double fused = _upperMedian(normalized, normalizedCount);
    if (!fused.isFinite || fused < 0 || fused > _maxFloat32) {
      throw StateError('High-precision focus score exceeded Float32 range.');
    }
    score[pixel] = fused;
  }
  return score;
}

/// Builds the same per-frame score while retaining only one full-resolution
/// scale plane in memory. Scale planes are persisted as exact Float32 bytes
/// and fused back in bounded chunks after all noise floors are known.
Future<Float32List> buildHighPrecisionFocusFrameScoreFileBacked({
  required LuminancePlane alignedLuminance,
  Uint8List? validMask,
  List<int> supportRadii = const <int>[1, 2, 4],
  int fusionChunkPixels = 262144,
  void Function()? checkCancelled,
}) async {
  final Directory resultDirectory =
      await Directory.systemTemp.createTemp('mobile_stack_focus_score_result_');
  final File resultFile = File(
    '${resultDirectory.path}${Platform.pathSeparator}score.f32',
  );
  try {
    await writeHighPrecisionFocusFrameScoreFileBacked(
      alignedLuminance: alignedLuminance,
      outputFile: resultFile,
      validMask: validMask,
      supportRadii: supportRadii,
      fusionChunkPixels: fusionChunkPixels,
      checkCancelled: checkCancelled,
    );
    final Uint8List bytes = await resultFile.readAsBytes();
    final int pixels = alignedLuminance.width * alignedLuminance.height;
    if (bytes.lengthInBytes != pixels * Float32List.bytesPerElement) {
      throw StateError('Focus score file length does not match dimensions.');
    }
    return Float32List.view(bytes.buffer, bytes.offsetInBytes, pixels);
  } finally {
    if (await resultDirectory.exists()) {
      await resultDirectory.delete(recursive: true);
    }
  }
}

/// Writes one frame's exact fused multi-scale score without retaining the
/// full fused plane in memory. Both the scale planes and the output fusion are
/// file-backed and only bounded chunks are resident at a time.
Future<void> writeHighPrecisionFocusFrameScoreFileBacked({
  required LuminancePlane alignedLuminance,
  required File outputFile,
  Uint8List? validMask,
  List<int> supportRadii = const <int>[1, 2, 4],
  int fusionChunkPixels = 262144,
  void Function()? checkCancelled,
}) async {
  if (supportRadii.length < 3) {
    throw ArgumentError('At least three focus support radii are required.');
  }
  final int pixels = alignedLuminance.width * alignedLuminance.height;
  if (validMask != null && validMask.length != pixels) {
    throw ArgumentError('Marking coverage mask length mismatch.');
  }
  if (fusionChunkPixels <= 0) {
    throw ArgumentError.value(fusionChunkPixels, 'fusionChunkPixels');
  }

  final Directory temporaryDirectory =
      await Directory.systemTemp.createTemp('mobile_stack_focus_scale_');
  final List<File> scaleFiles = <File>[];
  final List<double> floors = <double>[];
  try {
    for (int scaleIndex = 0; scaleIndex < supportRadii.length; scaleIndex++) {
      checkCancelled?.call();
      final File scaleFile = File(
        '${temporaryDirectory.path}${Platform.pathSeparator}'
        'scale-$scaleIndex.f32',
      );
      floors.add(
        await _writeFocusScale(
          alignedLuminance: alignedLuminance,
          validMask: validMask,
          supportRadius: supportRadii[scaleIndex],
          outputFile: scaleFile,
          checkCancelled: checkCancelled,
        ),
      );
      scaleFiles.add(scaleFile);
    }

    final List<RandomAccessFile> readers = <RandomAccessFile>[];
    RandomAccessFile? scoreWriter;
    try {
      for (final File scaleFile in scaleFiles) {
        readers.add(await scaleFile.open(mode: FileMode.read));
      }
      scoreWriter = await outputFile.open(mode: FileMode.write);
      final Float64List normalized = Float64List(scaleFiles.length);
      final int chunkCapacity = math.min(fusionChunkPixels, pixels);
      final List<Uint8List> byteChunks = <Uint8List>[
        for (int scale = 0; scale < scaleFiles.length; scale++)
          Uint8List(chunkCapacity * Float32List.bytesPerElement),
      ];
      final List<ByteData> scaleChunks = <ByteData>[
        for (final Uint8List bytes in byteChunks) ByteData.sublistView(bytes),
      ];
      final Float32List scoreChunk = Float32List(chunkCapacity);
      for (int pixelStart = 0;
          pixelStart < pixels;
          pixelStart += fusionChunkPixels) {
        checkCancelled?.call();
        final int chunkPixels = math.min(
          fusionChunkPixels,
          pixels - pixelStart,
        );
        final int chunkBytes = chunkPixels * Float32List.bytesPerElement;
        scoreChunk.fillRange(0, chunkPixels, 0);
        for (int scale = 0; scale < readers.length; scale++) {
          await _readExactBytes(
            readers[scale],
            byteChunks[scale],
            chunkBytes,
          );
        }
        for (int localPixel = 0; localPixel < chunkPixels; localPixel++) {
          final int pixel = pixelStart + localPixel;
          if (validMask != null && validMask[pixel] == 0) continue;
          int normalizedCount = 0;
          final int byteOffset = localPixel * Float32List.bytesPerElement;
          for (int scale = 0; scale < scaleChunks.length; scale++) {
            final double raw = scaleChunks[scale].getFloat32(
              byteOffset,
              Endian.host,
            );
            final double floor = floors[scale];
            final double value = floor > 0 ? raw / floor : raw;
            if (value.isFinite && value > 0) {
              normalized[normalizedCount++] = value;
            }
          }
          if (normalizedCount < 2) continue;
          final double fused = _upperMedian(normalized, normalizedCount);
          if (!fused.isFinite || fused < 0 || fused > _maxFloat32) {
            throw StateError(
              'High-precision focus score exceeded Float32 range.',
            );
          }
          scoreChunk[localPixel] = fused;
        }
        await scoreWriter.writeFrom(
          scoreChunk.buffer.asUint8List(0, chunkBytes),
        );
      }
      await scoreWriter.flush();
    } finally {
      await _closeHighPrecisionFilesBestEffort(<RandomAccessFile?>[
        scoreWriter,
        ...readers.reversed,
      ]);
    }
  } finally {
    if (await temporaryDirectory.exists()) {
      await temporaryDirectory.delete(recursive: true);
    }
  }
}

Future<void> _closeHighPrecisionFilesBestEffort(
  Iterable<RandomAccessFile?> handles,
) async {
  Object? firstError;
  StackTrace? firstStackTrace;
  for (final RandomAccessFile? handle in handles) {
    if (handle == null) continue;
    try {
      await handle.close();
    } catch (error, stackTrace) {
      firstError ??= error;
      firstStackTrace ??= stackTrace;
    }
  }
  if (firstError != null) {
    Error.throwWithStackTrace(firstError, firstStackTrace!);
  }
}

Future<void> _readExactBytes(
  RandomAccessFile reader,
  Uint8List bytes,
  int byteCount,
) async {
  int byteOffset = 0;
  while (byteOffset < byteCount) {
    final int read = await reader.readInto(bytes, byteOffset, byteCount);
    if (read == 0) {
      throw StateError('Focus score file ended before its last pixel.');
    }
    byteOffset += read;
  }
}

Future<double> _writeFocusScale({
  required LuminancePlane alignedLuminance,
  required Uint8List? validMask,
  required int supportRadius,
  required File outputFile,
  void Function()? checkCancelled,
}) async {
  await writeModifiedLaplacianFocusMeasureFile(
    luminance: alignedLuminance,
    supportRadius: supportRadius,
    outputFile: outputFile,
    validMask: validMask,
    checkCancelled: checkCancelled,
  );
  final int pixels = alignedLuminance.width * alignedLuminance.height;
  final Float32List floorSelection = Float32List(pixels);
  final Uint8List bytes = floorSelection.buffer.asUint8List();
  final RandomAccessFile reader = await outputFile.open(mode: FileMode.read);
  try {
    int byteOffset = 0;
    while (byteOffset < bytes.length) {
      final int read = await reader.readInto(bytes, byteOffset, bytes.length);
      if (read == 0) {
        throw StateError('Focus scale file ended before its last pixel.');
      }
      byteOffset += read;
    }
  } finally {
    await reader.close();
  }
  return _robustPositiveNoiseFloorInPlace(floorSelection);
}

/// Selects marking masks from already fused per-frame scores without
/// materializing full-resolution winner-index and winner-confidence planes.
HighPrecisionFocusMarking buildHighPrecisionFocusMarkingFromScores({
  required int width,
  required int height,
  required List<Float32List> combinedScores,
  required List<Uint8List?> validMasks,
  double minimumMarkConfidence = 0.18,
  double acceptableBestScoreRatio = 0.88,
  bool retainConfidence = true,
}) {
  if (width <= 0 ||
      height <= 0 ||
      combinedScores.length < 2 ||
      validMasks.length != combinedScores.length ||
      !minimumMarkConfidence.isFinite ||
      minimumMarkConfidence < 0 ||
      minimumMarkConfidence > 1 ||
      !acceptableBestScoreRatio.isFinite ||
      acceptableBestScoreRatio <= 0 ||
      acceptableBestScoreRatio > 1) {
    throw ArgumentError('Invalid high-precision focus score input.');
  }
  final int pixels = width * height;
  for (final Float32List scores in combinedScores) {
    if (scores.length != pixels ||
        scores.any((double value) => !value.isFinite || value < 0)) {
      throw ArgumentError('High-precision focus score plane is invalid.');
    }
  }
  for (final Uint8List? mask in validMasks) {
    if (mask != null && mask.length != pixels) {
      throw ArgumentError('Marking coverage mask length mismatch.');
    }
  }

  final double sceneFloor = _sceneNoiseFloor(combinedScores, pixels);

  final List<Uint8List> frameMasks = <Uint8List>[
    for (int i = 0; i < combinedScores.length; i++) Uint8List(pixels),
  ];
  // Confidence is required while deciding masks, but the production review
  // UI never consumes the full-resolution confidence plane. Keep retention
  // optional so callers that need diagnostics/tests can preserve it exactly.
  final Float32List displayConfidence =
      retainConfidence ? Float32List(pixels) : Float32List(0);
  final Float32List roundedConfidence = Float32List(1);
  final List<int> markedCounts = List<int>.filled(combinedScores.length, 0);

  for (int pixel = 0; pixel < pixels; pixel++) {
    int winner = 0;
    double bestScore = combinedScores[0][pixel];
    double secondScore = -1;
    for (int frame = 1; frame < combinedScores.length; frame++) {
      final double candidate = combinedScores[frame][pixel];
      if (candidate > bestScore) {
        secondScore = bestScore;
        bestScore = candidate;
        winner = frame;
      } else if (candidate > secondScore) {
        secondScore = candidate;
      }
    }
    double confidence = 0;
    if (bestScore > 0) {
      if (secondScore < 0) secondScore = 0;
      confidence =
          ((bestScore - secondScore) / bestScore).clamp(0, 1).toDouble();
    }
    roundedConfidence[0] = confidence;
    confidence = roundedConfidence[0];
    final bool bestStrongEnough =
        sceneFloor <= 0 ? bestScore > 0 : bestScore >= sceneFloor;
    if (!bestStrongEnough) continue;

    if (retainConfidence) displayConfidence[pixel] = confidence;
    for (int frame = 0; frame < combinedScores.length; frame++) {
      final bool covered =
          validMasks[frame] == null || validMasks[frame]![pixel] != 0;
      if (!covered) continue;
      final double score = combinedScores[frame][pixel];
      if (!(score > 0)) continue;
      final double ratio = bestScore > 0 ? score / bestScore : 0;
      final bool reliableWinner =
          frame == winner && confidence >= minimumMarkConfidence;
      final bool reliableOverlap =
          frame != winner && ratio >= acceptableBestScoreRatio;
      if (!reliableWinner && !reliableOverlap) continue;
      frameMasks[frame][pixel] = 1;
      markedCounts[frame]++;
    }
  }

  return HighPrecisionFocusMarking(
    width: width,
    height: height,
    frameCount: combinedScores.length,
    confidence: displayConfidence,
    frameMasks: frameMasks,
    coverageFractions: <double>[
      for (final int count in markedCounts) count / pixels,
    ],
  );
}

/// Selects marking masks from file-backed fused frame scores. It is exactly
/// equivalent to [buildHighPrecisionFocusMarkingFromScores], but never keeps
/// all frame score planes in memory at once.
Future<HighPrecisionFocusMarking> buildHighPrecisionFocusMarkingFromScoreFiles({
  required int width,
  required int height,
  required List<File> combinedScoreFiles,
  List<Uint8List?>? validMasks,
  List<File?>? validMaskFiles,
  double minimumMarkConfidence = 0.18,
  double acceptableBestScoreRatio = 0.88,
  int chunkPixels = 262144,
  bool retainConfidence = true,
  void Function()? checkCancelled,
}) async {
  if (width <= 0 ||
      height <= 0 ||
      combinedScoreFiles.length < 2 ||
      (validMasks == null && validMaskFiles == null) ||
      (validMasks != null && validMaskFiles != null) ||
      (validMasks != null && validMasks.length != combinedScoreFiles.length) ||
      (validMaskFiles != null &&
          validMaskFiles.length != combinedScoreFiles.length) ||
      !minimumMarkConfidence.isFinite ||
      minimumMarkConfidence < 0 ||
      minimumMarkConfidence > 1 ||
      !acceptableBestScoreRatio.isFinite ||
      acceptableBestScoreRatio <= 0 ||
      acceptableBestScoreRatio > 1 ||
      chunkPixels <= 0) {
    throw ArgumentError('Invalid file-backed high-precision focus input.');
  }
  final int pixels = width * height;
  final int expectedBytes = pixels * Float32List.bytesPerElement;
  for (final File scoreFile in combinedScoreFiles) {
    if (await scoreFile.length() != expectedBytes) {
      throw ArgumentError('High-precision focus score file is invalid.');
    }
  }
  if (validMasks != null) {
    for (final Uint8List? mask in validMasks) {
      if (mask != null && mask.length != pixels) {
        throw ArgumentError('Marking coverage mask length mismatch.');
      }
    }
  } else {
    for (final File? maskFile in validMaskFiles!) {
      if (maskFile != null && await maskFile.length() != pixels) {
        throw ArgumentError('Marking coverage mask file length mismatch.');
      }
    }
  }

  final double sceneFloor = await _sceneNoiseFloorFromScoreFiles(
    combinedScoreFiles,
    pixels,
    chunkPixels: chunkPixels,
    checkCancelled: checkCancelled,
  );
  final List<Uint8List> frameMasks = <Uint8List>[
    for (int i = 0; i < combinedScoreFiles.length; i++) Uint8List(pixels),
  ];
  final Float32List displayConfidence =
      retainConfidence ? Float32List(pixels) : Float32List(0);
  final Float32List roundedConfidence = Float32List(1);
  final List<int> markedCounts = List<int>.filled(combinedScoreFiles.length, 0);
  final List<RandomAccessFile> readers = <RandomAccessFile>[];
  final List<RandomAccessFile?> maskReaders = <RandomAccessFile?>[];
  try {
    for (final File scoreFile in combinedScoreFiles) {
      readers.add(await scoreFile.open(mode: FileMode.read));
    }
    if (validMaskFiles != null) {
      for (final File? maskFile in validMaskFiles) {
        maskReaders.add(
          maskFile == null ? null : await maskFile.open(mode: FileMode.read),
        );
      }
    }
    final int chunkCapacity = math.min(chunkPixels, pixels);
    final List<Uint8List> byteChunks = <Uint8List>[
      for (int frame = 0; frame < combinedScoreFiles.length; frame++)
        Uint8List(chunkCapacity * Float32List.bytesPerElement),
    ];
    final List<ByteData> scoreChunks = <ByteData>[
      for (final Uint8List bytes in byteChunks) ByteData.sublistView(bytes),
    ];
    final List<Uint8List> maskChunks = <Uint8List>[
      if (validMaskFiles != null)
        for (int frame = 0; frame < combinedScoreFiles.length; frame++)
          Uint8List(chunkCapacity),
    ];
    for (int pixelStart = 0; pixelStart < pixels; pixelStart += chunkPixels) {
      checkCancelled?.call();
      final int currentChunkPixels = math.min(
        chunkPixels,
        pixels - pixelStart,
      );
      final int chunkBytes = currentChunkPixels * Float32List.bytesPerElement;
      for (int frame = 0; frame < readers.length; frame++) {
        await _readExactBytes(readers[frame], byteChunks[frame], chunkBytes);
      }
      if (validMaskFiles != null) {
        for (int frame = 0; frame < maskReaders.length; frame++) {
          final RandomAccessFile? reader = maskReaders[frame];
          if (reader == null) continue;
          await _readExactBytes(
            reader,
            maskChunks[frame],
            currentChunkPixels,
          );
        }
      }
      for (int localPixel = 0; localPixel < currentChunkPixels; localPixel++) {
        final int pixel = pixelStart + localPixel;
        final int byteOffset = localPixel * Float32List.bytesPerElement;
        int winner = 0;
        double bestScore = scoreChunks[0].getFloat32(byteOffset, Endian.host);
        double secondScore = -1;
        for (int frame = 1; frame < scoreChunks.length; frame++) {
          final double candidate =
              scoreChunks[frame].getFloat32(byteOffset, Endian.host);
          if (candidate > bestScore) {
            secondScore = bestScore;
            bestScore = candidate;
            winner = frame;
          } else if (candidate > secondScore) {
            secondScore = candidate;
          }
        }
        double confidence = 0;
        if (bestScore > 0) {
          if (secondScore < 0) secondScore = 0;
          confidence =
              ((bestScore - secondScore) / bestScore).clamp(0, 1).toDouble();
        }
        roundedConfidence[0] = confidence;
        confidence = roundedConfidence[0];
        final bool bestStrongEnough =
            sceneFloor <= 0 ? bestScore > 0 : bestScore >= sceneFloor;
        if (!bestStrongEnough) continue;

        if (retainConfidence) displayConfidence[pixel] = confidence;
        for (int frame = 0; frame < scoreChunks.length; frame++) {
          final bool covered = validMasks != null
              ? validMasks[frame] == null || validMasks[frame]![pixel] != 0
              : validMaskFiles![frame] == null ||
                  maskChunks[frame][localPixel] != 0;
          if (!covered) continue;
          final double score =
              scoreChunks[frame].getFloat32(byteOffset, Endian.host);
          if (!(score > 0)) continue;
          final double ratio = bestScore > 0 ? score / bestScore : 0;
          final bool reliableWinner =
              frame == winner && confidence >= minimumMarkConfidence;
          final bool reliableOverlap =
              frame != winner && ratio >= acceptableBestScoreRatio;
          if (!reliableWinner && !reliableOverlap) continue;
          frameMasks[frame][pixel] = 1;
          markedCounts[frame]++;
        }
      }
    }
  } finally {
    await _closeHighPrecisionFilesBestEffort(<RandomAccessFile?>[
      ...maskReaders.reversed,
      ...readers.reversed,
    ]);
  }

  return HighPrecisionFocusMarking(
    width: width,
    height: height,
    frameCount: combinedScoreFiles.length,
    confidence: displayConfidence,
    frameMasks: frameMasks,
    coverageFractions: <double>[
      for (final int count in markedCounts) count / pixels,
    ],
  );
}

Future<double> _sceneNoiseFloorFromScoreFiles(
  List<File> scoreFiles,
  int pixels, {
  required int chunkPixels,
  void Function()? checkCancelled,
}) async {
  final Float32List bestScores = Float32List(pixels);
  final List<RandomAccessFile> readers = <RandomAccessFile>[];
  try {
    for (final File scoreFile in scoreFiles) {
      readers.add(await scoreFile.open(mode: FileMode.read));
    }
    final int chunkCapacity = math.min(chunkPixels, pixels);
    final List<Uint8List> byteChunks = <Uint8List>[
      for (int frame = 0; frame < scoreFiles.length; frame++)
        Uint8List(chunkCapacity * Float32List.bytesPerElement),
    ];
    final List<ByteData> scoreChunks = <ByteData>[
      for (final Uint8List bytes in byteChunks) ByteData.sublistView(bytes),
    ];
    for (int pixelStart = 0; pixelStart < pixels; pixelStart += chunkPixels) {
      checkCancelled?.call();
      final int currentChunkPixels = math.min(
        chunkPixels,
        pixels - pixelStart,
      );
      final int chunkBytes = currentChunkPixels * Float32List.bytesPerElement;
      for (int frame = 0; frame < readers.length; frame++) {
        await _readExactBytes(readers[frame], byteChunks[frame], chunkBytes);
      }
      for (int localPixel = 0; localPixel < currentChunkPixels; localPixel++) {
        final int byteOffset = localPixel * Float32List.bytesPerElement;
        double bestScore = scoreChunks[0].getFloat32(byteOffset, Endian.host);
        if (!bestScore.isFinite || bestScore < 0) {
          throw ArgumentError('High-precision focus score file is invalid.');
        }
        for (int frame = 1; frame < scoreChunks.length; frame++) {
          final double candidate =
              scoreChunks[frame].getFloat32(byteOffset, Endian.host);
          if (!candidate.isFinite || candidate < 0) {
            throw ArgumentError('High-precision focus score file is invalid.');
          }
          if (candidate > bestScore) bestScore = candidate;
        }
        bestScores[pixelStart + localPixel] = bestScore;
      }
    }
  } finally {
    for (final RandomAccessFile reader in readers.reversed) {
      await reader.close();
    }
  }
  return _robustPositiveNoiseFloorInPlace(bestScores);
}

double _sceneNoiseFloor(List<Float32List> combinedScores, int pixels) {
  int positiveBestScoreCount = 0;
  for (int pixel = 0; pixel < pixels; pixel++) {
    double bestScore = combinedScores[0][pixel];
    for (int frame = 1; frame < combinedScores.length; frame++) {
      final double candidate = combinedScores[frame][pixel];
      if (candidate > bestScore) bestScore = candidate;
    }
    if (bestScore > 0 && bestScore.isFinite) positiveBestScoreCount++;
  }
  final Float32List positiveBestScores = Float32List(positiveBestScoreCount);
  int positiveBestScoreIndex = 0;
  for (int pixel = 0; pixel < pixels; pixel++) {
    double bestScore = combinedScores[0][pixel];
    for (int frame = 1; frame < combinedScores.length; frame++) {
      final double candidate = combinedScores[frame][pixel];
      if (candidate > bestScore) bestScore = candidate;
    }
    if (bestScore > 0 && bestScore.isFinite) {
      positiveBestScores[positiveBestScoreIndex++] = bestScore;
    }
  }
  return _robustPositiveNoiseFloor(positiveBestScores);
}

double _upperMedian(Float64List values, int count) {
  if (count == 2) {
    return values[0] >= values[1] ? values[0] : values[1];
  }
  if (count == 3) {
    final double a = values[0];
    final double b = values[1];
    final double c = values[2];
    if (a < b) {
      if (b < c) return b;
      return a < c ? c : a;
    }
    if (a < c) return a;
    return b < c ? c : b;
  }
  values.fillRange(count, values.length, double.infinity);
  values.sort();
  return values[count ~/ 2];
}

double _robustPositiveNoiseFloor(Float32List values) {
  int positiveCount = 0;
  for (final double value in values) {
    if (value.isFinite && value > 0) positiveCount++;
  }
  if (positiveCount == 0) return 0;
  final Float32List positive = Float32List(positiveCount);
  int positiveIndex = 0;
  for (final double value in values) {
    if (value.isFinite && value > 0) positive[positiveIndex++] = value;
  }
  final int lowerLength = math.max(1, positive.length ~/ 2);
  final int middle = lowerLength ~/ 2;
  return lowerLength.isOdd
      ? _selectKth(positive, middle)
      : 0.5 * (_selectKth(positive, middle - 1) + _selectKth(positive, middle));
}

double _robustPositiveNoiseFloorInPlace(Float32List values) {
  int positiveCount = 0;
  for (final double value in values) {
    if (value.isFinite && value > 0) {
      values[positiveCount++] = value;
    }
  }
  if (positiveCount == 0) return 0;
  final Float32List positive =
      Float32List.sublistView(values, 0, positiveCount);
  final int lowerLength = math.max(1, positive.length ~/ 2);
  final int middle = lowerLength ~/ 2;
  return lowerLength.isOdd
      ? _selectKth(positive, middle)
      : 0.5 * (_selectKth(positive, middle - 1) + _selectKth(positive, middle));
}

double _selectKth(Float32List values, int target) {
  int left = 0;
  int right = values.length - 1;
  while (true) {
    if (left == right) return values[left];
    final double pivot = values[left + ((right - left) ~/ 2)];
    int lower = left;
    int scan = left;
    int upper = right;
    while (scan <= upper) {
      final double value = values[scan];
      if (value < pivot) {
        final double swap = values[lower];
        values[lower] = value;
        values[scan] = swap;
        lower++;
        scan++;
      } else if (value > pivot) {
        final double swap = values[upper];
        values[upper] = value;
        values[scan] = swap;
        upper--;
      } else {
        scan++;
      }
    }
    if (target < lower) {
      right = lower - 1;
    } else if (target <= upper) {
      return pivot;
    } else {
      left = upper + 1;
    }
  }
}

const double _maxFloat32 = 3.4028234663852886e38;
