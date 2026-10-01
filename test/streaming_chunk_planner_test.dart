import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/pipeline/streaming_chunk_planner.dart';

void main() {
  test('空きメモリに応じて最大12枚以内のチャンク数を返す', () {
    const StreamingChunkPlanner planner = StreamingChunkPlanner();
    expect(
      planner.resolveChunkSize(
        availableMemoryBytes: 800,
        estimatedBytesPerFrame: 100,
      ),
      8,
    );
    expect(
      planner.resolveChunkSize(
        availableMemoryBytes: 5000,
        estimatedBytesPerFrame: 100,
      ),
      12,
    );
  });
}
