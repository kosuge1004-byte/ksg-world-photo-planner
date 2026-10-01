import 'dart:collection';

class TransientMemoryEntry {
  const TransientMemoryEntry({required this.value, required this.byteLength});

  final Object value;
  final int byteLength;
}

class TransientMemoryStore {
  TransientMemoryStore({required this.maximumBytes})
      : assert(maximumBytes >= 0);

  final int maximumBytes;
  final LinkedHashMap<String, TransientMemoryEntry> _entries =
      LinkedHashMap<String, TransientMemoryEntry>();
  int _usedBytes = 0;

  int get usedBytes => _usedBytes;
  int get entryCount => _entries.length;

  void put(String key, Object value, {required int byteLength}) {
    if (byteLength < 0) throw ArgumentError.value(byteLength, 'byteLength');
    final TransientMemoryEntry? previous = _entries.remove(key);
    if (previous != null) _usedBytes -= previous.byteLength;

    if (byteLength > maximumBytes) return;
    _entries[key] = TransientMemoryEntry(value: value, byteLength: byteLength);
    _usedBytes += byteLength;
    _evictUntilWithinBudget();
  }

  T? get<T>(String key) {
    final TransientMemoryEntry? entry = _entries.remove(key);
    if (entry == null) return null;
    _entries[key] = entry;
    return entry.value is T ? entry.value as T : null;
  }

  void remove(String key) {
    final TransientMemoryEntry? entry = _entries.remove(key);
    if (entry != null) _usedBytes -= entry.byteLength;
  }

  void clear() {
    _entries.clear();
    _usedBytes = 0;
  }

  void _evictUntilWithinBudget() {
    while (_usedBytes > maximumBytes && _entries.isNotEmpty) {
      final String oldestKey = _entries.keys.first;
      remove(oldestKey);
    }
  }
}
