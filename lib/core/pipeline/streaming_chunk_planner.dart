class StreamingChunkPlanner {
  const StreamingChunkPlanner({
    this.maximumChunkSize = 12,
    this.minimumChunkSize = 1,
  })  : assert(maximumChunkSize >= 1),
        assert(minimumChunkSize >= 1),
        assert(minimumChunkSize <= maximumChunkSize);

  final int maximumChunkSize;
  final int minimumChunkSize;

  int resolveChunkSize({
    required int availableMemoryBytes,
    required int estimatedBytesPerFrame,
  }) {
    if (estimatedBytesPerFrame <= 0) return maximumChunkSize;
    final int byMemory = availableMemoryBytes ~/ estimatedBytesPerFrame;
    return byMemory.clamp(minimumChunkSize, maximumChunkSize);
  }

  List<List<T>> split<T>(List<T> items, int chunkSize) {
    if (chunkSize <= 0) throw ArgumentError.value(chunkSize, 'chunkSize');
    final List<List<T>> result = <List<T>>[];
    for (int start = 0; start < items.length; start += chunkSize) {
      final int end = (start + chunkSize).clamp(0, items.length);
      result.add(List<T>.unmodifiable(items.sublist(start, end)));
    }
    return result;
  }
}
