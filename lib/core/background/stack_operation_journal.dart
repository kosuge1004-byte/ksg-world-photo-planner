import 'dart:convert';
import 'dart:io';

/// Small process-death-safe journal that records the operation the processor
/// entered *before* beginning risky work. If the processor freezes or dies,
/// the last ENTER record remains available to the UI/supervisor on restart.
final class StackOperationJournal {
  StackOperationJournal(this.statusPath)
      : path = '${File(statusPath).parent.path}${Platform.pathSeparator}'
            'processor_operation_journal.json';

  static const int _version = 1;
  static const int _maxEvents = 64;

  final String statusPath;
  final String path;

  Future<void> enter({
    required String operation,
    String? stage,
    int? frameIndex,
    int? committedItems,
  }) =>
      _record(
        event: 'ENTER',
        operation: operation,
        stage: stage,
        frameIndex: frameIndex,
        committedItems: committedItems,
      );

  Future<void> complete({
    required String operation,
    String? stage,
    int? frameIndex,
    int? committedItems,
  }) =>
      _record(
        event: 'COMPLETE',
        operation: operation,
        stage: stage,
        frameIndex: frameIndex,
        committedItems: committedItems,
      );

  Future<void> failed({required String operation, String? stage}) =>
      _record(event: 'FAILED', operation: operation, stage: stage);

  static final Map<String, Future<void>> _tails = <String, Future<void>>{};
  Future<void> _record(
      {required String event,
      required String operation,
      String? stage,
      int? frameIndex,
      int? committedItems}) {
    final prior = _tails[path] ?? Future<void>.value();
    final next = prior.catchError((Object _) {}).then((_) => _recordUnlocked(
        event: event,
        operation: operation,
        stage: stage,
        frameIndex: frameIndex,
        committedItems: committedItems));
    _tails[path] = next;
    return next;
  }

  Future<void> _recordUnlocked({
    required String event,
    required String operation,
    String? stage,
    int? frameIndex,
    int? committedItems,
  }) async {
    final File file = File(path);
    await file.parent.create(recursive: true);
    List<dynamic> events = <dynamic>[];
    try {
      if (await file.exists()) {
        final Object? decoded = jsonDecode(await file.readAsString());
        if (decoded is Map<String, dynamic> && decoded['events'] is List) {
          events = List<dynamic>.of(decoded['events'] as List<dynamic>);
        }
      }
    } on Object {
      events = <dynamic>[];
    }
    events.add(<String, Object?>{
      'event': event,
      'operation': operation,
      if (stage != null) 'stage': stage,
      if (frameIndex != null) 'frameIndex': frameIndex,
      if (committedItems != null) 'committedItems': committedItems,
      'timestampEpochMs': DateTime.now().millisecondsSinceEpoch,
      'pid': pid,
    });
    if (events.length > _maxEvents) {
      events = events.sublist(events.length - _maxEvents);
    }
    final Map<String, Object?> payload = <String, Object?>{
      'version': _version,
      'updatedEpochMs': DateTime.now().millisecondsSinceEpoch,
      'events': events,
    };
    final File temporary =
        File('$path.tmp.$pid.${DateTime.now().microsecondsSinceEpoch}');
    try {
      await temporary.writeAsString(jsonEncode(payload), flush: true);
      await temporary.rename(path);
    } finally {
      if (await temporary.exists()) {
        try {
          await temporary.delete();
        } on Object {/* best effort */}
      }
    }
  }
}
