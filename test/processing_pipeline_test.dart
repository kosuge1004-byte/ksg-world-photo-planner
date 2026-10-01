import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/engine/processing_job.dart';
import 'package:mobile_stack/core/memory/transient_memory_store.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/core/pipeline/execution_target.dart';
import 'package:mobile_stack/core/pipeline/pipeline_context.dart';
import 'package:mobile_stack/core/pipeline/pipeline_stage.dart';
import 'package:mobile_stack/core/pipeline/processing_pipeline.dart';
import 'package:mobile_stack/core/tiles/tile_grid.dart';

void main() {
  test('ステージ重みに基づいて全体進捗を集計する', () async {
    final List<double> progress = <double>[];
    final ProcessingJob job = ProcessingJob(
      id: 'job-1',
      mode: ProcessingMode.milkyWay,
      sourcePath: '/test.ARW',
    );
    final ProcessingPipeline pipeline = ProcessingPipeline(
      stages: <PipelineStage>[
        PipelineStage(
          id: 'a',
          label: 'A',
          weight: 1,
          target: ExecutionTarget.cpu,
          runner: (job, context, report) async => report(1),
        ),
        PipelineStage(
          id: 'b',
          label: 'B',
          weight: 3,
          target: ExecutionTarget.gpu,
          runner: (job, context, report) async => report(1),
        ),
      ],
    );

    await pipeline.run(
      job,
      PipelineContext(
        memoryStore: TransientMemoryStore(maximumBytes: 1024),
        tileGrid: const TileGrid(),
      ),
      progress.add,
    );

    expect(progress.last, 1);
    expect(job.currentStageId, 'b');
    expect(job.executionTarget, ExecutionTarget.gpu);
  });

  test('キャンセル要求後は後続ステージを開始しない', () async {
    int started = 0;
    final ProcessingJob job = ProcessingJob(
      id: 'job-2',
      mode: ProcessingMode.starTrail,
      sourcePath: '/test.NEF',
    );
    final ProcessingPipeline pipeline = ProcessingPipeline(
      stages: <PipelineStage>[
        PipelineStage(
          id: 'a',
          label: 'A',
          weight: 1,
          target: ExecutionTarget.cpu,
          runner: (job, context, report) async {
            started++;
            job.requestCancellation();
          },
        ),
        PipelineStage(
          id: 'b',
          label: 'B',
          weight: 1,
          target: ExecutionTarget.cpu,
          runner: (job, context, report) async => started++,
        ),
      ],
    );

    await pipeline.run(
      job,
      PipelineContext(
        memoryStore: TransientMemoryStore(maximumBytes: 1024),
        tileGrid: const TileGrid(),
      ),
      (_) {},
    );

    expect(started, 1);
  });
}
