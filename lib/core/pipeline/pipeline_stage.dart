import '../engine/processing_job.dart';
import 'execution_target.dart';
import 'pipeline_context.dart';

typedef PipelineStageRunner = Future<void> Function(
  ProcessingJob job,
  PipelineContext context,
  void Function(double progress) reportProgress,
);

class PipelineStage {
  const PipelineStage({
    required this.id,
    required this.label,
    required this.weight,
    required this.target,
    required this.runner,
    this.releasesTransientDataAfterRun = false,
  }) : assert(weight > 0);

  final String id;
  final String label;
  final double weight;
  final ExecutionTarget target;
  final PipelineStageRunner runner;
  final bool releasesTransientDataAfterRun;
}
