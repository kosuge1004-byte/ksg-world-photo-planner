import '../models/processing_mode.dart';
import '../pipeline/execution_target.dart';

enum ProcessingJobState { queued, running, completed, failed, cancelled }

class ProcessingJob {
  ProcessingJob({
    required this.id,
    required this.mode,
    required this.sourcePath,
  });

  final String id;
  final ProcessingMode mode;
  final String sourcePath;

  ProcessingJobState state = ProcessingJobState.queued;
  double progress = 0;
  Object? error;
  StackTrace? errorStackTrace;
  bool cancellationRequested = false;
  String? currentStageId;
  String? currentStageLabel;
  String? lastCompletedStageId;
  String? lastCompletedStageLabel;
  ExecutionTarget? executionTarget;

  bool get isTerminal => switch (state) {
        ProcessingJobState.completed ||
        ProcessingJobState.failed ||
        ProcessingJobState.cancelled =>
          true,
        _ => false,
      };

  void requestCancellation() {
    cancellationRequested = true;
    if (state == ProcessingJobState.queued) {
      state = ProcessingJobState.cancelled;
    }
  }
}
