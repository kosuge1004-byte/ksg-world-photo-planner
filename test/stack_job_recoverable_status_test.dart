import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/background/stack_job_status.dart';

void main() {
  test('recoverable interruption survives status serialization', () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-recoverable-status-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final String path = '${directory.path}/status.json';
    const StackJobStatus source = StackJobStatus(
      state: StackJobState.interruptedRecoverable,
      progress: 0.42,
      stage: '中断・再開可能',
      currentItem: 120,
      totalItems: 354,
      elapsedSeconds: 900,
      updatedEpochMs: 123456,
      progressEpochMs: 123000,
      heartbeat: 22,
      error: 'synthetic failure',
      recoverableCheckpointItems: 120,
    );
    await source.writeAtomically(path);
    final StackJobStatus? restored = await StackJobStatus.readFile(path);
    expect(restored, isNotNull);
    expect(restored!.state, StackJobState.interruptedRecoverable);
    expect(restored.recoverableCheckpointItems, 120);
    expect(restored.progressEpochMs, 123000);
    expect(restored.error, 'synthetic failure');
  });

  test('legacy status uses heartbeat timestamp as progress timestamp', () {
    final StackJobStatus restored = StackJobStatus.fromMap(<String, dynamic>{
      'state': 'running',
      'updatedEpochMs': 987654,
    });
    expect(restored.progressEpochMs, 987654);
  });
}
