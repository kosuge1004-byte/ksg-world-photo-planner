import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';

enum StackJobState {
  queued,
  running,
  completed,
  failed,
  interruptedRecoverable,
  cancelled,
}

final class StackJobStatus {
  const StackJobStatus({
    required this.state,
    required this.progress,
    required this.stage,
    required this.currentItem,
    required this.totalItems,
    required this.elapsedSeconds,
    required this.updatedEpochMs,
    required this.heartbeat,
    this.progressEpochMs = 0,
    this.outputPath,
    this.error,
    this.recoverableCheckpointItems = 0,
    this.recoveryAttempt = 0,
    this.recoveryMaxAttempts = 2,
    this.recoveryCause,
    this.lastProcessorExitReason,
    this.lastProcessorExitTimestampMs,
    this.revision = 0,
  });

  final StackJobState state;
  final double progress;
  final String stage;
  final int currentItem;
  final int totalItems;
  final int elapsedSeconds;
  final int updatedEpochMs;
  final int heartbeat;

  /// Wall-clock time of the last actual forward progress. Unlike
  /// [updatedEpochMs], a proof-of-life heartbeat does not advance this value.
  final int progressEpochMs;
  final String? outputPath;
  final String? error;
  final int recoverableCheckpointItems;
  final int recoveryAttempt;
  final int recoveryMaxAttempts;
  final String? recoveryCause;
  final String? lastProcessorExitReason;
  final int? lastProcessorExitTimestampMs;
  final int revision;

  StackJobStatus copyWith({
    StackJobState? state,
    double? progress,
    String? stage,
    int? currentItem,
    int? totalItems,
    int? elapsedSeconds,
    int? updatedEpochMs,
    int? heartbeat,
    int? progressEpochMs,
    String? outputPath,
    String? error,
    bool clearOutputPath = false,
    bool clearError = false,
    int? recoverableCheckpointItems,
    int? recoveryAttempt,
    int? recoveryMaxAttempts,
    String? recoveryCause,
    bool clearRecoveryCause = false,
    String? lastProcessorExitReason,
    int? lastProcessorExitTimestampMs,
    int? revision,
  }) {
    return StackJobStatus(
      state: state ?? this.state,
      progress: progress ?? this.progress,
      stage: stage ?? this.stage,
      currentItem: currentItem ?? this.currentItem,
      totalItems: totalItems ?? this.totalItems,
      elapsedSeconds: elapsedSeconds ?? this.elapsedSeconds,
      updatedEpochMs: updatedEpochMs ?? this.updatedEpochMs,
      heartbeat: heartbeat ?? this.heartbeat,
      progressEpochMs: progressEpochMs ?? this.progressEpochMs,
      outputPath: clearOutputPath ? null : (outputPath ?? this.outputPath),
      error: clearError ? null : (error ?? this.error),
      recoverableCheckpointItems:
          recoverableCheckpointItems ?? this.recoverableCheckpointItems,
      recoveryAttempt: recoveryAttempt ?? this.recoveryAttempt,
      recoveryMaxAttempts: recoveryMaxAttempts ?? this.recoveryMaxAttempts,
      recoveryCause:
          clearRecoveryCause ? null : (recoveryCause ?? this.recoveryCause),
      lastProcessorExitReason:
          lastProcessorExitReason ?? this.lastProcessorExitReason,
      lastProcessorExitTimestampMs:
          lastProcessorExitTimestampMs ?? this.lastProcessorExitTimestampMs,
      revision: revision ?? this.revision,
    );
  }

  Map<String, dynamic> toMap() => <String, dynamic>{
        'revision': revision,
        'state': state.name,
        'progress': progress,
        'stage': stage,
        'currentItem': currentItem,
        'totalItems': totalItems,
        'elapsedSeconds': elapsedSeconds,
        'updatedEpochMs': updatedEpochMs,
        'heartbeat': heartbeat,
        'progressEpochMs': progressEpochMs,
        if (outputPath != null) 'outputPath': outputPath,
        if (error != null) 'error': error,
        'recoverableCheckpointItems': recoverableCheckpointItems,
        'recoveryAttempt': recoveryAttempt,
        'recoveryMaxAttempts': recoveryMaxAttempts,
        if (recoveryCause != null) 'recoveryCause': recoveryCause,
        if (lastProcessorExitReason != null)
          'lastProcessorExitReason': lastProcessorExitReason,
        if (lastProcessorExitTimestampMs != null)
          'lastProcessorExitTimestampMs': lastProcessorExitTimestampMs,
      };

  static StackJobStatus fromMap(Map<String, dynamic> map) {
    return StackJobStatus(
      revision: (map['revision'] as num?)?.toInt() ?? 0,
      state: StackJobState.values.firstWhere(
        (StackJobState value) => value.name == map['state'],
        orElse: () => StackJobState.failed,
      ),
      progress: (map['progress'] as num?)?.toDouble() ?? 0,
      stage: map['stage'] as String? ?? '状態不明',
      currentItem: (map['currentItem'] as num?)?.toInt() ?? 0,
      totalItems: (map['totalItems'] as num?)?.toInt() ?? 0,
      elapsedSeconds: (map['elapsedSeconds'] as num?)?.toInt() ?? 0,
      updatedEpochMs: (map['updatedEpochMs'] as num?)?.toInt() ?? 0,
      heartbeat: (map['heartbeat'] as num?)?.toInt() ?? 0,
      progressEpochMs: (map['progressEpochMs'] as num?)?.toInt() ??
          (map['updatedEpochMs'] as num?)?.toInt() ??
          0,
      outputPath: map['outputPath'] as String?,
      error: map['error'] as String?,
      recoverableCheckpointItems:
          (map['recoverableCheckpointItems'] as num?)?.toInt() ?? 0,
      recoveryAttempt: (map['recoveryAttempt'] as num?)?.toInt() ?? 0,
      recoveryMaxAttempts: (map['recoveryMaxAttempts'] as num?)?.toInt() ?? 2,
      recoveryCause: map['recoveryCause'] as String?,
      lastProcessorExitReason: map['lastProcessorExitReason'] as String?,
      lastProcessorExitTimestampMs:
          (map['lastProcessorExitTimestampMs'] as num?)?.toInt(),
    );
  }

  static Future<StackJobStatus?> readFile(String path) async {
    final File file = File(path);
    if (!await file.exists()) return null;
    try {
      final Object? decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map<String, dynamic>) return null;
      return fromMap(decoded);
    } on Object {
      return null;
    }
  }

  /// Marker file used to request cancellation — see [requestCancellation]
  /// and [isCancellationRequested] for why this is a separate file rather
  /// than a field on the JSON status file itself.
  static String _cancelMarkerPath(String statusPath) => '$statusPath.cancel';

  /// Requests that the background job persisting status to [statusPath]
  /// stop at its next safe point.
  ///
  /// This is deliberately a separate marker file rather than a field
  /// merged into the status JSON. That file is rewritten by the worker
  /// roughly once a second as part of ordinary progress reporting
  /// (`StackJobReporter.publish()`); a flag embedded in it would be racing
  /// against those routine overwrites — the foreground screen could set it
  /// only for the worker's very next unrelated progress publish (built from
  /// in-memory state that knows nothing about the flag) to silently write
  /// it back to "not requested" before the worker ever notices. A
  /// dedicated file the worker only ever reads, and only ever deletes once
  /// (on its own terminal state), has no such writer race.
  static Future<void> requestCancellation(String statusPath) async {
    final File marker = File(_cancelMarkerPath(statusPath));
    await marker.parent.create(recursive: true);
    await marker.writeAsString(
      DateTime.now().toIso8601String(),
      flush: true,
    );
  }

  /// Whether [requestCancellation] has been called for [statusPath] and not
  /// yet cleared by [clearCancellationRequest].
  static Future<bool> isCancellationRequested(String statusPath) {
    return File(_cancelMarkerPath(statusPath)).exists();
  }

  /// Removes the cancellation marker, if any. Called once a job reaches any
  /// terminal state so a stale marker can never affect a later job that
  /// happens to reuse the same status path.
  static Future<void> clearCancellationRequest(String statusPath) async {
    final File marker = File(_cancelMarkerPath(statusPath));
    if (await marker.exists()) {
      try {
        await marker.delete();
      } on Object {
        // Best-effort cleanup; a leftover marker only matters if a future
        // job reuses this exact path, which callers avoid via unique names.
      }
    }
  }

  /// Preliminary lifecycle guard. The authoritative write below uses a
  /// shared cross-process lock and revision check; state rank alone is not
  /// sufficient to protect a read-modify-write from stale writers.
  static int _stateRank(StackJobState state) => switch (state) {
        StackJobState.completed ||
        StackJobState.failed ||
        StackJobState.cancelled =>
          2,
        StackJobState.interruptedRecoverable => 1,
        StackJobState.queued || StackJobState.running => 0,
      };

  static const MethodChannel _statusChannel =
      MethodChannel('com.mobilestack.app/stack_status');
  static final Map<String, Future<void>> _pendingWrites =
      <String, Future<void>>{};

  /// Returns the committed state, or the current state if this snapshot was
  /// stale. Android has one Kotlin transaction implementation for every writer;
  /// Dart must never fall back to an uncoordinated file write on channel failure.
  Future<StackJobStatus> writeAtomically(
    String path, {
    bool allowStateDowngrade = false,
  }) async {
    if (Platform.isAndroid) {
      final String? text = await _statusChannel.invokeMethod<String>(
        'writeSnapshot',
        <String, Object>{
          'path': path,
          'snapshot': jsonEncode(toMap()),
          'resume': allowStateDowngrade,
        },
      );
      if (text == null) {
        throw StateError('Status transaction returned no state.');
      }
      return fromMap(jsonDecode(text) as Map<String, dynamic>);
    }
    final String key = File(path).absolute.path;
    final Future<void> previous = _pendingWrites[key] ?? Future<void>.value();
    final Completer<void> done = Completer<void>();
    _pendingWrites[key] = done.future;
    await previous;
    try {
      return await _writeLocked(path, allowStateDowngrade);
    } finally {
      done.complete();
      if (identical(_pendingWrites[key], done.future)) {
        _pendingWrites.remove(key);
      }
    }
  }

  Future<StackJobStatus> _writeLocked(String path, bool resume) async {
    final File file = File(path);
    await file.parent.create(recursive: true);
    final RandomAccessFile lock =
        await File('$path.lock').open(mode: FileMode.append);
    await lock.lock(FileLock.blockingExclusive);
    try {
      final StackJobStatus? existing = await file.exists()
          ? fromMap(
              jsonDecode(await file.readAsString()) as Map<String, dynamic>)
          : null;
      if (existing != null &&
          (existing.revision != revision ||
              _stateRank(existing.state) == 2 ||
              (!resume && _stateRank(existing.state) > _stateRank(state)))) {
        return existing;
      }
      final StackJobStatus committed = copyWith(
        revision: (existing?.revision ?? 0) + 1,
        recoverableCheckpointItems:
            (existing?.recoverableCheckpointItems ?? 0) >
                    recoverableCheckpointItems
                ? existing!.recoverableCheckpointItems
                : recoverableCheckpointItems,
        lastProcessorExitReason: existing?.lastProcessorExitReason,
        lastProcessorExitTimestampMs: existing?.lastProcessorExitTimestampMs,
      );
      final File temporary = File(
        '$path.tmp.$pid.${DateTime.now().microsecondsSinceEpoch}',
      );
      try {
        await temporary.writeAsString(jsonEncode(committed.toMap()),
            flush: true);
        // File.rename replaces an existing file/link. Do not delete the current
        // status first: keeping it in place until rename closes the process-death
        // window where no authoritative status file exists. A unique temp name
        // also prevents reporter/onTaskStopped writes from sharing one .tmp file.
        await temporary.rename(path);
        return committed;
      } finally {
        if (await temporary.exists()) {
          await temporary.delete();
        }
      }
    } finally {
      await lock.unlock();
      await lock.close();
    }
  }
}
