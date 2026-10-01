import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/focus_stack/file_backed_focus_winner_map.dart';
import 'package:mobile_stack/core/focus_stack/focus_map_regularizer.dart';
import 'package:mobile_stack/core/focus_stack/focus_measure_file_selection.dart';
import 'package:mobile_stack/core/focus_stack/focus_winner_map.dart';

Future<File> _scoreFile(Directory dir, int frame, List<double> values) async {
  final Float32List scores = Float32List.fromList(values);
  final File file = File('${dir.path}/score-$frame.f32');
  await file.writeAsBytes(scores.buffer.asUint8List(), flush: true);
  return file;
}

Future<FileBackedFocusWinnerMap> _mapFromMemory(
  Directory dir,
  String prefix,
  FocusWinnerMap source,
) async {
  final FileBackedFocusWinnerMap map =
      await FileBackedFocusWinnerMap.createTemporary(
    width: source.width,
    height: source.height,
    directory: dir,
    prefix: prefix,
  );
  await map.writeAllFromChunks(
    producer: (RandomAccessFile labels, RandomAccessFile confidence) async {
      await labels.writeFrom(source.frameIndices.buffer.asUint8List());
      await confidence.writeFrom(source.confidence.buffer.asUint8List());
    },
  );
  return map;
}

void main() {
  test('file-backed winner selection matches legacy selector', () async {
    final Directory dir =
        await Directory.systemTemp.createTemp('work305-focus-test-');
    try {
      final List<File> files = <File>[
        await _scoreFile(dir, 0, <double>[1, 4, 2, 8, 1, 4]),
        await _scoreFile(dir, 1, <double>[2, 3, 2.1, 7, 3, 4.1]),
        await _scoreFile(dir, 2, <double>[3, 2, 1, 6, 2, 4.2]),
      ];
      final FocusWinnerMap legacy = await selectAndRefineFocusWinnersFromFiles(
        width: 3,
        height: 2,
        measureFiles: files,
        chunkPixels: 2,
      );
      final FileBackedFocusWinnerMap backed =
          await selectAndRefineFocusWinnersToFiles(
        width: 3,
        height: 2,
        measureFiles: files,
        chunkPixels: 2,
        temporaryDirectory: dir,
      );
      try {
        final FocusWinnerRegion region = await backed.readRegion(
          x: 0,
          y: 0,
          width: 3,
          height: 2,
        );
        expect(region.frameIndices, orderedEquals(legacy.frameIndices));
        expect(region.confidence, orderedEquals(legacy.confidence));
      } finally {
        await backed.dispose();
      }
    } finally {
      if (await dir.exists()) await dir.delete(recursive: true);
    }
  });

  test('file-backed two-pass regularizer matches in-memory result', () async {
    final Directory dir =
        await Directory.systemTemp.createTemp('work305-reg-test-');
    try {
      const int width = 5;
      const int height = 4;
      final FocusWinnerMap source = FocusWinnerMap(
        width: width,
        height: height,
        frameIndices: Int32List.fromList(<int>[
          0,
          0,
          0,
          1,
          1,
          0,
          0,
          1,
          1,
          1,
          0,
          2,
          2,
          1,
          1,
          2,
          2,
          2,
          2,
          1,
        ]),
        confidence: Float32List.fromList(<double>[
          .9,
          .8,
          .2,
          .8,
          .9,
          .8,
          .1,
          .2,
          .2,
          .8,
          .7,
          .2,
          .1,
          .2,
          .7,
          .9,
          .8,
          .7,
          .8,
          .9,
        ]),
      );
      final FocusWinnerMap expected = regularizeFocusWinnerMap(
        FocusWinnerMap(
          width: width,
          height: height,
          frameIndices: Int32List.fromList(source.frameIndices),
          confidence: Float32List.fromList(source.confidence),
        ),
        maximumIterations: 2,
        reuseInputBuffers: true,
      );
      final FileBackedFocusWinnerMap sourceBacked =
          await _mapFromMemory(dir, 'source', source);
      final FileBackedFocusWinnerMap result =
          await regularizeFileBackedFocusWinnerMapTwoPass(
        sourceBacked,
        temporaryDirectory: dir,
      );
      try {
        final FocusWinnerRegion region = await result.readRegion(
          x: 0,
          y: 0,
          width: width,
          height: height,
        );
        expect(region.frameIndices, orderedEquals(expected.frameIndices));
        expect(region.confidence, orderedEquals(expected.confidence));
      } finally {
        await result.dispose();
        await sourceBacked.dispose();
      }
    } finally {
      if (await dir.exists()) await dir.delete(recursive: true);
    }
  });
}
