import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/background/background_input_stager.dart';

void main() {
  late Directory root;
  late Directory job;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('background-input-stager-');
    job = Directory('${root.path}${Platform.pathSeparator}job');
    await job.create();
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  test('copies bytes to indexed job-owned paths and sanitizes names', () async {
    final File first =
        File('${root.path}${Platform.pathSeparator}first raw.ARW');
    final File second = File('${root.path}${Platform.pathSeparator}second.NEF');
    await first.writeAsBytes(<int>[1, 2, 3, 4]);
    await second.writeAsBytes(<int>[9, 8, 7]);

    final List<String> staged = await BackgroundInputStager.stageGroup(
      jobDirectory: job,
      groupName: 'source',
      sourcePaths: <String>[first.path, second.path],
    );

    expect(staged, hasLength(2));
    expect(staged[0], endsWith('00000_first_raw.ARW'));
    expect(staged[1], endsWith('00001_second.NEF'));
    expect(await File(staged[0]).readAsBytes(), <int>[1, 2, 3, 4]);
    expect(await File(staged[1]).readAsBytes(), <int>[9, 8, 7]);
    expect(Directory(first.parent.path).path,
        isNot(Directory(File(staged[0]).parent.path).path));
  });

  test('missing later file removes every input group already staged', () async {
    final File source = File('${root.path}${Platform.pathSeparator}source.ARW');
    await source.writeAsBytes(<int>[1]);
    await BackgroundInputStager.stageGroup(
      jobDirectory: job,
      groupName: 'source',
      sourcePaths: <String>[source.path],
    );

    await expectLater(
      BackgroundInputStager.stageGroup(
        jobDirectory: job,
        groupName: 'dark',
        sourcePaths: <String>[
          '${root.path}${Platform.pathSeparator}missing.ARW',
        ],
      ),
      throwsStateError,
    );
    expect(Directory('${job.path}${Platform.pathSeparator}inputs').existsSync(),
        isFalse);
  });

  test('rejects empty RAW files', () async {
    final File empty = File('${root.path}${Platform.pathSeparator}empty.ARW');
    await empty.create();
    await expectLater(
      BackgroundInputStager.stageGroup(
        jobDirectory: job,
        groupName: 'source',
        sourcePaths: <String>[empty.path],
      ),
      throwsStateError,
    );
  });

  test('rejects a group name that could escape the job input directory', () {
    expect(
      () => BackgroundInputStager.stageGroup(
        jobDirectory: job,
        groupName: '../outside',
        sourcePaths: <String>['unused'],
      ),
      throwsArgumentError,
    );
  });
}
