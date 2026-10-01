import 'dart:io';
import 'dart:typed_data';

import 'focus_winner_map.dart';
import 'file_backed_focus_winner_map.dart';

/// Selects focus winners and applies the same adjacent-frame order refinement
/// as the in-memory path while reading Float32 measure planes in bounded
/// chunks. Score files are frame-major, native-endian Float32 planes.
Future<FocusWinnerMap> selectAndRefineFocusWinnersFromFiles({
  required int width,
  required int height,
  required List<File> measureFiles,
  double absoluteScoreFloor = 0,
  double confidenceThreshold = 0.25,
  double adjacentScoreRatio = 0.98,
  int chunkPixels = 65536,
  void Function()? checkCancelled,
}) async {
  if (width <= 0 || height <= 0 || measureFiles.length < 2) {
    throw ArgumentError('At least two valid focus-measure files are required.');
  }
  if (!absoluteScoreFloor.isFinite || absoluteScoreFloor < 0) {
    throw ArgumentError.value(absoluteScoreFloor, 'absoluteScoreFloor');
  }
  if (!confidenceThreshold.isFinite ||
      confidenceThreshold < 0 ||
      confidenceThreshold > 1 ||
      !adjacentScoreRatio.isFinite ||
      adjacentScoreRatio <= 0 ||
      adjacentScoreRatio > 1 ||
      chunkPixels <= 0) {
    throw ArgumentError('Invalid file-backed focus winner parameters.');
  }

  final int pixelCount = width * height;
  final int expectedBytes = pixelCount * Float32List.bytesPerElement;
  final List<RandomAccessFile> readers = <RandomAccessFile>[];
  try {
    for (final File file in measureFiles) {
      if (await file.length() != expectedBytes) {
        throw StateError('Focus-measure score file has an invalid length.');
      }
      readers.add(await file.open(mode: FileMode.read));
    }
    final List<Float32List> chunks = <Float32List>[
      for (int frame = 0; frame < readers.length; frame++)
        Float32List(chunkPixels),
    ];
    final Int32List winners = Int32List(pixelCount);
    final Float32List confidence = Float32List(pixelCount);

    for (int start = 0; start < pixelCount; start += chunkPixels) {
      checkCancelled?.call();
      final int count =
          start + chunkPixels <= pixelCount ? chunkPixels : pixelCount - start;
      await _readScoreChunks(readers, chunks, start, count);
      for (int local = 0; local < count; local++) {
        int bestFrame = 0;
        double best = chunks[0][local];
        if (!best.isFinite || best < 0) {
          throw StateError('Focus-measure score file contains invalid data.');
        }
        double second = -1;
        for (int frame = 1; frame < chunks.length; frame++) {
          final double score = chunks[frame][local];
          if (!score.isFinite || score < 0) {
            throw StateError('Focus-measure score file contains invalid data.');
          }
          if (score > best) {
            second = best;
            best = score;
            bestFrame = frame;
          } else if (score > second) {
            second = score;
          }
        }
        final int pixel = start + local;
        winners[pixel] = bestFrame;
        if (best <= absoluteScoreFloor || best <= 0) continue;
        if (second < 0) second = 0;
        confidence[pixel] = ((best - second) / best).clamp(0, 1).toDouble();
      }
    }

    // The selected buffers are owned here. Order refinement changes only the
    // current pixel's label and never observes neighboring labels, so it can
    // update this winner plane directly without a second full pair.
    for (int start = 0; start < pixelCount; start += chunkPixels) {
      checkCancelled?.call();
      final int count =
          start + chunkPixels <= pixelCount ? chunkPixels : pixelCount - start;
      await _readScoreChunks(readers, chunks, start, count);
      for (int local = 0; local < count; local++) {
        final int pixel = start + local;
        if (confidence[pixel] >= confidenceThreshold) continue;
        final int current = winners[pixel];
        final double currentScore = chunks[current][local];
        int bestAdjacent = current;
        double bestAdjacentScore = currentScore;
        for (final int candidate in <int>[current - 1, current + 1]) {
          if (candidate < 0 || candidate >= chunks.length) continue;
          final double score = chunks[candidate][local];
          if (score > bestAdjacentScore) {
            bestAdjacentScore = score;
            bestAdjacent = candidate;
          }
        }
        if (bestAdjacent != current &&
            currentScore <= bestAdjacentScore * adjacentScoreRatio) {
          winners[pixel] = bestAdjacent;
        }
      }
    }
    return FocusWinnerMap(
      width: width,
      height: height,
      frameIndices: winners,
      confidence: confidence,
    );
  } finally {
    for (final RandomAccessFile reader in readers.reversed) {
      await reader.close();
    }
  }
}

Future<void> _readScoreChunks(
  List<RandomAccessFile> readers,
  List<Float32List> chunks,
  int startPixel,
  int count,
) async {
  final int byteOffset = startPixel * Float32List.bytesPerElement;
  final int byteCount = count * Float32List.bytesPerElement;
  for (int frame = 0; frame < readers.length; frame++) {
    await readers[frame].setPosition(byteOffset);
    final Uint8List bytes = chunks[frame].buffer.asUint8List(0, byteCount);
    int readOffset = 0;
    while (readOffset < byteCount) {
      final int read =
          await readers[frame].readInto(bytes, readOffset, byteCount);
      if (read == 0) {
        throw StateError('Focus-measure score file ended inside a chunk.');
      }
      readOffset += read;
    }
  }
}

/// File-backed equivalent of [selectAndRefineFocusWinnersFromFiles].
///
/// It performs the same two logical passes, but writes labels/confidence to
/// files and revisits them in bounded chunks for adjacent-frame refinement.
/// No full-image Int32 + Float32 winner pair is retained in Dart heap.
Future<FileBackedFocusWinnerMap> selectAndRefineFocusWinnersToFiles({
  required int width,
  required int height,
  required List<File> measureFiles,
  double absoluteScoreFloor = 0,
  double confidenceThreshold = 0.25,
  double adjacentScoreRatio = 0.98,
  int chunkPixels = 65536,
  Directory? temporaryDirectory,
  void Function()? checkCancelled,
}) async {
  if (width <= 0 || height <= 0 || measureFiles.length < 2) {
    throw ArgumentError('At least two valid focus-measure files are required.');
  }
  if (!absoluteScoreFloor.isFinite || absoluteScoreFloor < 0) {
    throw ArgumentError.value(absoluteScoreFloor, 'absoluteScoreFloor');
  }
  if (!confidenceThreshold.isFinite ||
      confidenceThreshold < 0 ||
      confidenceThreshold > 1 ||
      !adjacentScoreRatio.isFinite ||
      adjacentScoreRatio <= 0 ||
      adjacentScoreRatio > 1 ||
      chunkPixels <= 0) {
    throw ArgumentError('Invalid file-backed focus winner parameters.');
  }

  final int pixelCount = width * height;
  final int expectedBytes = pixelCount * Float32List.bytesPerElement;
  final List<RandomAccessFile> scoreReaders = <RandomAccessFile>[];
  FileBackedFocusWinnerMap? selected;
  try {
    for (final File file in measureFiles) {
      if (await file.length() != expectedBytes) {
        throw StateError('Focus-measure score file has an invalid length.');
      }
      scoreReaders.add(await file.open(mode: FileMode.read));
    }
    final List<Float32List> scoreChunks = <Float32List>[
      for (int frame = 0; frame < scoreReaders.length; frame++)
        Float32List(chunkPixels),
    ];
    selected = await FileBackedFocusWinnerMap.createTemporary(
      width: width,
      height: height,
      directory: temporaryDirectory,
      prefix: 'selected',
    );

    await selected.writeAllFromChunks(
      producer: (RandomAccessFile labelsWriter,
          RandomAccessFile confidenceWriter) async {
        final Int32List labels = Int32List(chunkPixels);
        final Float32List confidence = Float32List(chunkPixels);
        for (int start = 0; start < pixelCount; start += chunkPixels) {
          checkCancelled?.call();
          final int count = start + chunkPixels <= pixelCount
              ? chunkPixels
              : pixelCount - start;
          await _readScoreChunks(scoreReaders, scoreChunks, start, count);
          for (int local = 0; local < count; local++) {
            int bestFrame = 0;
            double best = scoreChunks[0][local];
            if (!best.isFinite || best < 0) {
              throw StateError(
                  'Focus-measure score file contains invalid data.');
            }
            double second = -1;
            for (int frame = 1; frame < scoreChunks.length; frame++) {
              final double score = scoreChunks[frame][local];
              if (!score.isFinite || score < 0) {
                throw StateError(
                    'Focus-measure score file contains invalid data.');
              }
              if (score > best) {
                second = best;
                best = score;
                bestFrame = frame;
              } else if (score > second) {
                second = score;
              }
            }
            labels[local] = bestFrame;
            if (best <= absoluteScoreFloor || best <= 0) {
              confidence[local] = 0;
            } else {
              if (second < 0) second = 0;
              confidence[local] =
                  ((best - second) / best).clamp(0, 1).toDouble();
            }
          }
          await labelsWriter.writeFrom(
            labels.buffer.asUint8List(
              0,
              count * Int32List.bytesPerElement,
            ),
          );
          await confidenceWriter.writeFrom(
            confidence.buffer.asUint8List(
              0,
              count * Float32List.bytesPerElement,
            ),
          );
        }
      },
    );

    // Refine into a second file-backed map so reads are never affected by
    // writes. This matches the in-memory function's second-pass semantics.
    final FileBackedFocusWinnerMap refined =
        await FileBackedFocusWinnerMap.createTemporary(
      width: width,
      height: height,
      directory: temporaryDirectory,
      prefix: 'adjacent-refined',
    );
    final RandomAccessFile labelsReader =
        await selected.labelsFile.open(mode: FileMode.read);
    final RandomAccessFile confidenceReader =
        await selected.confidenceFile.open(mode: FileMode.read);
    try {
      await refined.writeAllFromChunks(
        producer: (RandomAccessFile labelsWriter,
            RandomAccessFile confidenceWriter) async {
          final Int32List labels = Int32List(chunkPixels);
          final Float32List confidence = Float32List(chunkPixels);
          for (int start = 0; start < pixelCount; start += chunkPixels) {
            checkCancelled?.call();
            final int count = start + chunkPixels <= pixelCount
                ? chunkPixels
                : pixelCount - start;
            await _readScoreChunks(scoreReaders, scoreChunks, start, count);
            await labelsReader.setPosition(start * Int32List.bytesPerElement);
            await confidenceReader
                .setPosition(start * Float32List.bytesPerElement);
            await _readExactSelection(
              labelsReader,
              labels.buffer.asUint8List(
                0,
                count * Int32List.bytesPerElement,
              ),
            );
            await _readExactSelection(
              confidenceReader,
              confidence.buffer.asUint8List(
                0,
                count * Float32List.bytesPerElement,
              ),
            );
            for (int local = 0; local < count; local++) {
              if (confidence[local] >= confidenceThreshold) continue;
              final int current = labels[local];
              final double currentScore = scoreChunks[current][local];
              int bestAdjacent = current;
              double bestAdjacentScore = currentScore;
              final int lower = current - 1;
              if (lower >= 0 && scoreChunks[lower][local] > bestAdjacentScore) {
                bestAdjacent = lower;
                bestAdjacentScore = scoreChunks[lower][local];
              }
              final int upper = current + 1;
              if (upper < scoreChunks.length &&
                  scoreChunks[upper][local] > bestAdjacentScore) {
                bestAdjacent = upper;
                bestAdjacentScore = scoreChunks[upper][local];
              }
              if (bestAdjacent != current &&
                  currentScore <= bestAdjacentScore * adjacentScoreRatio) {
                labels[local] = bestAdjacent;
              }
            }
            await labelsWriter.writeFrom(
              labels.buffer.asUint8List(
                0,
                count * Int32List.bytesPerElement,
              ),
            );
            await confidenceWriter.writeFrom(
              confidence.buffer.asUint8List(
                0,
                count * Float32List.bytesPerElement,
              ),
            );
          }
        },
      );
    } finally {
      await labelsReader.close();
      await confidenceReader.close();
      await selected.dispose();
      selected = null;
    }
    return refined;
  } finally {
    for (final RandomAccessFile reader in scoreReaders.reversed) {
      await reader.close();
    }
    await selected?.dispose();
  }
}

Future<void> _readExactSelection(
  RandomAccessFile file,
  Uint8List destination,
) async {
  int offset = 0;
  while (offset < destination.length) {
    final int read = await file.readInto(
      destination,
      offset,
      destination.length,
    );
    if (read == 0) {
      throw StateError('Focus winner file ended inside a chunk.');
    }
    offset += read;
  }
}
