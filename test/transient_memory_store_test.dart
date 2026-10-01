import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/memory/transient_memory_store.dart';

void main() {
  test('容量超過時に最も古い一時データを破棄する', () {
    final TransientMemoryStore store = TransientMemoryStore(maximumBytes: 10);
    store.put('a', 'A', byteLength: 6);
    store.put('b', 'B', byteLength: 6);

    expect(store.get<String>('a'), isNull);
    expect(store.get<String>('b'), 'B');
    expect(store.usedBytes, 6);
  });
}
