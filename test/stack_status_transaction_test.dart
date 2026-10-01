import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/background/stack_job_status.dart';

const seed = StackJobStatus(
    state: StackJobState.running,
    progress: .2,
    stage: 'decode',
    currentItem: 2,
    totalItems: 10,
    elapsedSeconds: 20,
    updatedEpochMs: 100,
    heartbeat: 1,
    recoverableCheckpointItems: 2);

void main() {
  late Directory directory;
  late String path;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('status-transaction-');
    path = '${directory.path}/status.json';
  });
  tearDown(() => directory.delete(recursive: true));

  test('only one of simultaneous snapshots with the same revision commits',
      () async {
    final first = await seed.writeAtomically(path);
    final results = await Future.wait([
      first.copyWith(currentItem: 3, heartbeat: 2).writeAtomically(path),
      first.copyWith(currentItem: 4, heartbeat: 3).writeAtomically(path),
    ]);
    expect(results.map((s) => s.revision).toSet(), {2});
    expect((await StackJobStatus.readFile(path))!.revision, 2);
  });

  test('stale heartbeat cannot erase a pause or checkpoint', () async {
    final running = await seed.writeAtomically(path);
    final pause = await running
        .copyWith(
            state: StackJobState.interruptedRecoverable,
            recoverableCheckpointItems: 4)
        .writeAtomically(path);
    final rejected =
        await running.copyWith(heartbeat: 99).writeAtomically(path);
    expect(rejected.state, StackJobState.interruptedRecoverable);
    expect(rejected.revision, pause.revision);
    final resumed = await pause
        .copyWith(state: StackJobState.running, recoverableCheckpointItems: 0)
        .writeAtomically(path, allowStateDowngrade: true);
    expect(resumed.recoverableCheckpointItems, 4);
  });

  test('terminal state cannot be changed even with explicit resume permission',
      () async {
    final running = await seed.writeAtomically(path);
    final completed = await running
        .copyWith(state: StackJobState.completed, outputPath: '/finished.dng')
        .writeAtomically(path);
    final rejected = await completed
        .copyWith(state: StackJobState.running, clearOutputPath: true)
        .writeAtomically(path, allowStateDowngrade: true);
    expect(rejected.state, StackJobState.completed);
    expect(rejected.outputPath, '/finished.dng');
    expect(rejected.revision, completed.revision);
  });

  test('unreadable current state is preserved rather than replaced', () async {
    await File(path).writeAsString('{broken');
    await expectLater(seed.writeAtomically(path), throwsFormatException);
    expect(await File(path).readAsString(), '{broken');
  });
}
