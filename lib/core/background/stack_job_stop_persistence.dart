import 'stack_job_status.dart';

/// Persists a quick non-terminal snapshot when Android WorkManager stops a
/// running worker before the Dart task callback finishes. WorkManager may
/// re-enqueue stopped work, so only a later authoritative WorkInfo query may
/// convert this to a terminal cancelled/failed state.
Future<void> persistStoppedStackJob({
  required String statusPath,
  required String reason,
}) async {
  final StackJobStatus? current = await StackJobStatus.readFile(statusPath);
  if (current == null ||
      current.state == StackJobState.completed ||
      current.state == StackJobState.failed ||
      current.state == StackJobState.interruptedRecoverable ||
      current.state == StackJobState.cancelled) {
    return;
  }
  await current
      .copyWith(
        state: StackJobState.queued,
        stage: '一時停止・再開判定中 ($reason)',
        updatedEpochMs: DateTime.now().millisecondsSinceEpoch,
        clearError: true,
        clearOutputPath: true,
      )
      .writeAtomically(statusPath);
}
