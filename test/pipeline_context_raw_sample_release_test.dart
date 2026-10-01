import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/memory/transient_memory_store.dart';
import 'package:mobile_stack/core/pipeline/pipeline_context.dart';
import 'package:mobile_stack/core/tiles/tile_grid.dart';

void main() {
  test('raw sample release is idempotent and cleared', () {
    int calls = 0;
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(),
    );
    context.releaseRawSamples = () => calls++;
    context.releaseRawSampleStorage();
    context.releaseRawSampleStorage();
    expect(calls, 1);
    expect(context.releaseRawSamples, isNull);
  });

  test('clearTransientData releases raw sample storage', () async {
    int calls = 0;
    final PipelineContext context = PipelineContext(
      memoryStore: TransientMemoryStore(maximumBytes: 1024),
      tileGrid: const TileGrid(),
    );
    context.releaseRawSamples = () => calls++;
    await context.clearTransientData();
    expect(calls, 1);
    expect(context.releaseRawSamples, isNull);
  });
}
