import 'dart:async';

import '../engine/processing_job.dart';
import 'execution_target.dart';
import 'pipeline_context.dart';
import 'pipeline_stage.dart';
import 'processing_pipeline.dart';

ProcessingPipeline createPhase1ValidationPipeline() {
  return ProcessingPipeline(
    stages: <PipelineStage>[
      PipelineStage(
        id: 'raw_read',
        label: 'RAW読込',
        weight: 2,
        target: ExecutionTarget.cpu,
        runner: _simulatedStage,
      ),
      PipelineStage(
        id: 'raw_decode',
        label: 'RAW展開',
        weight: 3,
        target: ExecutionTarget.cpu,
        runner: _simulatedStage,
      ),
      PipelineStage(
        id: 'analysis',
        label: '解析',
        weight: 2,
        target: ExecutionTarget.cpu,
        runner: _simulatedStage,
      ),
      PipelineStage(
        id: 'mode_processing',
        label: 'モード別処理',
        weight: 4,
        target: ExecutionTarget.gpu,
        runner: _simulatedStage,
        releasesTransientDataAfterRun: true,
      ),
      PipelineStage(
        id: 'output',
        label: '出力',
        weight: 2,
        target: ExecutionTarget.cpu,
        runner: _simulatedStage,
        releasesTransientDataAfterRun: true,
      ),
    ],
  );
}

Future<void> _simulatedStage(
  ProcessingJob job,
  PipelineContext context,
  void Function(double progress) reportProgress,
) async {
  const int steps = 5;
  for (int step = 1; step <= steps; step++) {
    if (job.cancellationRequested) return;
    await Future<void>.delayed(const Duration(milliseconds: 28));
    reportProgress(step / steps);
  }

  context.metadata['lastCompletedStage'] = job.currentStageId;
  context.memoryStore.put(
    'stage:${job.currentStageId}',
    job.sourcePath,
    byteLength: 1024,
  );
}
