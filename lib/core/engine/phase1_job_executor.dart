import '../memory/transient_memory_store.dart';
import '../pipeline/phase1_pipeline_factory.dart';
import '../pipeline/pipeline_context.dart';
import '../tiles/tile_grid.dart';
import 'processing_job.dart';

/// Phase 1-4用のパイプライン接続確認Executor。
/// 実際のRAWデコードはまだ行わないが、RAW読込→展開→解析→モード処理→出力の
/// ステージ遷移、CPU/GPU属性、進捗集計、一時データ解放を検証する。
Future<void> runPhase1ValidationJob(
  ProcessingJob job,
  void Function(double progress) reportProgress,
) async {
  final PipelineContext context = PipelineContext(
    memoryStore: TransientMemoryStore(maximumBytes: 8 * 1024 * 1024),
    tileGrid: const TileGrid(),
  );
  final pipeline = createPhase1ValidationPipeline();
  try {
    await pipeline.run(job, context, reportProgress);
  } finally {
    await context.clearTransientData();
  }
}
