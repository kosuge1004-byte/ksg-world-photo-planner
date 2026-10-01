import '../engine/processing_job.dart';
import '../background/native_operation_trace.dart';
import 'pipeline_context.dart';
import 'pipeline_stage.dart';

class ProcessingPipeline {
  ProcessingPipeline({required List<PipelineStage> stages})
      : stages = List<PipelineStage>.unmodifiable(stages) {
    if (stages.isEmpty) {
      throw ArgumentError.value(stages, 'stages', '1つ以上のステージが必要です。');
    }
  }

  final List<PipelineStage> stages;

  Future<void> run(
    ProcessingJob job,
    PipelineContext context,
    void Function(double progress) reportProgress, {
    void Function(PipelineStage stage)? onStageChanged,
    // Fired once a stage's runner returns, with how long it actually took.
    // Distinct from `onStageChanged` (fired before the runner starts): this
    // exists so callers can log accurate per-stage timing without every
    // caller re-implementing its own Stopwatch around `stage.runner`. Prior
    // to this, some callers wrapped the *entire* multi-stage pipeline.run()
    // call in a single Stopwatch and logged it under one label (e.g.
    // "decode"), which silently included every other stage's time (demosaic,
    // calibration, ...) under that one misleading name.
    void Function(PipelineStage stage, Duration elapsed)? onStageTimed,
  }) async {
    final double totalWeight = stages.fold<double>(
      0,
      (double total, PipelineStage stage) => total + stage.weight,
    );
    double completedWeight = 0;

    for (final PipelineStage stage in stages) {
      if (job.cancellationRequested) return;
      onStageChanged?.call(stage);
      job.currentStageId = stage.id;
      job.currentStageLabel = stage.label;
      job.executionTarget = stage.target;

      final Stopwatch stageStopwatch = Stopwatch()..start();
      await traceNativeOperation(
          operation: stage.id,
          stage: job.sourcePath,
          call: () => stage.runner(job, context, (double stageProgress) {
                final double normalized = stageProgress.clamp(0, 1);
                reportProgress(
                  (completedWeight + stage.weight * normalized) / totalWeight,
                );
              }));
      stageStopwatch.stop();
      onStageTimed?.call(stage, stageStopwatch.elapsed);

      if (job.cancellationRequested) return;
      job.lastCompletedStageId = stage.id;
      job.lastCompletedStageLabel = stage.label;
      completedWeight += stage.weight;
      reportProgress(completedWeight / totalWeight);

      if (stage.releasesTransientDataAfterRun) {
        await context.clearTransientData();
      }
    }
  }
}
