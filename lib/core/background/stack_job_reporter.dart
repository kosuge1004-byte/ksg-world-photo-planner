import '../raw/raw_decoder_contract.dart';
import 'processing_failure_policy.dart';
import 'dart:async';
import 'dart:io';

import 'package:workmanager/workmanager.dart';

import '../diagnostics/diagnostic_log.dart';
import 'stack_job_notifications.dart';
import 'stack_job_status.dart';

/// Thrown by a background worker's own frame/tile loop once it observes
/// [StackJobReporter.cancellationRequested] — the signal that the person
/// tapped "中止" on the progress screen. Caught specifically (ahead of the
/// generic `on Object catch (error)`) so the job ends in
/// [StackJobState.cancelled] via [StackJobReporter.cancel] rather than
/// looking like an unexpected failure.

/// Internal control-flow signal used only at a durable checkpoint boundary to
/// recycle the disposable Android processor process and reclaim its entire
/// Dart/native heap. This is not a processing failure and must not consume the
/// bounded automatic-failure retry budget.
final class ProcessorMaintenanceRestartRequested implements Exception {
  const ProcessorMaintenanceRestartRequested(this.reason);

  final String reason;

  @override
  String toString() => reason;
}

final class StackJobCancelledException implements Exception {
  const StackJobCancelledException();

  @override
  String toString() => '処理は中止されました。';
}

final class StackJobReporter {
  StackJobReporter({
    required this.statusPath,
    required this.outputPath,
    required this.totalItems,
    this.jobLabel = '天の川スタック',
    this.completionMessage,
  }) : _startedAt = DateTime.now();

  final String statusPath;
  final String outputPath;
  final int totalItems;
  final String jobLabel;
  final String? completionMessage;
  final DateTime _startedAt;

  int _elapsedOffsetSeconds = 0;
  Timer? _heartbeatTimer;
  double _progress = 0;
  String _stage = '開始準備';
  int _currentItem = 0;
  int _heartbeat = 0;
  int _revision = 0;
  int _progressEpochMs = 0;
  StackJobState _state = StackJobState.queued;
  String? _error;
  int _recoverableCheckpointItems = 0;
  int _recoveryAttempt = 0;
  int _recoveryMaxAttempts = 2;
  String? _recoveryCause;
  String? _lastProcessorExitReason;
  int? _lastProcessorExitTimestampMs;
  DateTime? _lastPublishRequestedAt;
  DateTime? _lastPlatformPublishAt;
  bool _publishInFlight = false;
  StackJobStatus? _pendingSnapshot;
  bool _pendingForcePlatform = false;
  bool _pendingAllowStateDowngrade = false;
  final List<Completer<void>> _pendingWaiters = <Completer<void>>[];
  bool _bestEffortUpdateInFlight = false;
  double? _pendingBestEffortProgress;
  String? _pendingBestEffortStage;
  int? _pendingBestEffortCurrentItem;
  int? _pendingBestEffortCheckpointItems;

  // Set from the persisted status file — the only channel available between
  // the foreground progress screen's isolate (where "中止" is tapped) and
  // this worker's isolate. Refreshed opportunistically (see `update()` and
  // the heartbeat timer below) rather than on every call, since re-reading
  // the file on every one of potentially hundreds of per-tile progress
  // calls a second would be wasteful. A worst case of a few seconds'
  // latency between tapping "中止" and the job actually stopping is an
  // acceptable trade for that.
  bool _cancellationRequested = false;
  DateTime? _lastCancellationCheckAt;
  static const Duration _cancellationCheckInterval = Duration(seconds: 2);

  /// Whether the person has requested this job stop. Background workers
  /// should check this at each safe stopping point (between frames/tiles,
  /// never mid a single native call — see `external_stall_watchdog.dart`'s
  /// doc comment for why Dart cannot preempt one of those anyway) and throw
  /// [StackJobCancelledException] once true.
  bool get cancellationRequested => _cancellationRequested;

  static const Duration _minimumProgressPublishInterval = Duration(seconds: 1);
  static const Duration _minimumPlatformPublishInterval = Duration(seconds: 5);
  static const Duration _bestEffortTimeout = Duration(seconds: 10);

  /// Work358: bound for each platform call made while publishing (WorkManager
  /// progress, Android notification). The status file — the authoritative
  /// proof-of-life record read by the UI poll, the supervisor and the stall
  /// watchdog — is written first and is not affected. Without a bound, one
  /// slow Binder/plugin call held every awaited `update()` in the processing
  /// loop (the Work350 device log shows 10 s best-effort timeouts).
  static const Duration _platformCallTimeout = Duration(seconds: 3);

  /// Work358: true only inside the WorkManager-hosted dispatcher. On Android
  /// heavy jobs run in ProcessorService (`:processor`), where there is no
  /// WorkManager worker to receive `reportProgress`.
  static bool workManagerHosted = false;

  int get elapsedSeconds =>
      (_elapsedOffsetSeconds + DateTime.now().difference(_startedAt).inSeconds)
          .clamp(0, 1 << 31)
          .toInt();

  /// Returns `true` if the caller should proceed with processing, `false`
  /// if this job already reached a terminal state (`completed`, `failed`,
  /// or `cancelled`) and must not be run again.
  ///
  /// The false case exists for one specific race: ProcessorService returns
  /// START_REDELIVER_INTENT, so if the OS kills the :processor process
  /// after a job finished but before Android recorded the Service calling
  /// stopSelf(), the last Intent can be redelivered and this worker
  /// invoked again for a job whose status.json already says "completed".
  /// Silently proceeding would redo potentially hours of finished work,
  /// double-write output, and risk a fresh failure overwriting a
  /// completed result. A previous `interruptedRecoverable` state is the
  /// one previous state this deliberately still resumes past — see
  /// `publish(..., allowStateDowngrade: true)` below and
  /// `StackJobStatus._stateRank`'s wider guard against exactly this class
  /// of stale-write race for every other write in this reporter.
  Future<bool> start() async {
    // A WorkManager stop/process recreation can invoke the task again from the
    // beginning. Preserve cumulative elapsed time and heartbeat continuity
    // even though the image pipeline itself restarts from frame 1.
    final StackJobStatus? previous = await StackJobStatus.readFile(statusPath);
    if (previous != null &&
        (previous.state == StackJobState.completed ||
            previous.state == StackJobState.failed ||
            previous.state == StackJobState.cancelled)) {
      return false;
    }
    if (previous != null) {
      _elapsedOffsetSeconds = previous.elapsedSeconds;
      _heartbeat = previous.heartbeat;
      _revision = previous.revision;
      _recoverableCheckpointItems = previous.recoverableCheckpointItems;
      _progressEpochMs = previous.progressEpochMs;
      _recoveryAttempt = previous.recoveryAttempt;
      _recoveryMaxAttempts = previous.recoveryMaxAttempts;
      _recoveryCause = previous.recoveryCause;
      _lastProcessorExitReason = previous.lastProcessorExitReason;
      _lastProcessorExitTimestampMs = previous.lastProcessorExitTimestampMs;
    }
    _state = StackJobState.running;
    // A newly-created processor runtime is itself verified recovery progress.
    // Reset the stall clock so a 30-minute-old checkpoint is not killed by
    // the supervisor before its first decode/update callback can run.
    _progressEpochMs = DateTime.now().millisecondsSinceEpoch;
    await publish(forcePlatform: true, allowStateDowngrade: true);
    if (_state != StackJobState.running) return false;
    _heartbeatTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      unawaited(_runBestEffort(
        'heartbeat publish',
        () => publish(heartbeatOnly: true, forcePlatform: true),
      ));
      unawaited(_refreshCancellationFlag());
    });
    return _state == StackJobState.running;
  }

  Future<void> _runBestEffort(
    String operation,
    Future<void> Function() action,
  ) async {
    try {
      await action().timeout(_bestEffortTimeout);
    } on Object catch (error) {
      // Best-effort work must never keep the processor foreground service alive
      // after a durable terminal state, or surface as an unhandled asynchronous
      // error from high-frequency progress callbacks.
      try {
        await DiagnosticLog.log('$operation failed or timed out: $error')
            .timeout(_bestEffortTimeout);
      } on Object {
        // Diagnostics are best-effort too, especially during storage failure.
      }
    }
  }

  /// Reports high-frequency callback progress without allowing a transient
  /// status-file failure to become an unhandled isolate error. The external
  /// watchdog remains authoritative if durable progress stops advancing.
  void updateBestEffort({
    double? progress,
    String? stage,
    int? currentItem,
    int? recoverableCheckpointItems,
  }) {
    if (progress != null) _pendingBestEffortProgress = progress;
    if (stage != null) _pendingBestEffortStage = stage;
    if (currentItem != null) _pendingBestEffortCurrentItem = currentItem;
    if (recoverableCheckpointItems != null) {
      _pendingBestEffortCheckpointItems = recoverableCheckpointItems;
    }
    if (_bestEffortUpdateInFlight) return;
    _bestEffortUpdateInFlight = true;
    unawaited(_drainBestEffortUpdates());
  }

  bool get _hasPendingBestEffortUpdate =>
      _pendingBestEffortProgress != null ||
      _pendingBestEffortStage != null ||
      _pendingBestEffortCurrentItem != null ||
      _pendingBestEffortCheckpointItems != null;

  Future<void> _drainBestEffortUpdates() async {
    try {
      while (_hasPendingBestEffortUpdate) {
        final double? progress = _pendingBestEffortProgress;
        final String? stage = _pendingBestEffortStage;
        final int? currentItem = _pendingBestEffortCurrentItem;
        final int? checkpointItems = _pendingBestEffortCheckpointItems;
        _pendingBestEffortProgress = null;
        _pendingBestEffortStage = null;
        _pendingBestEffortCurrentItem = null;
        _pendingBestEffortCheckpointItems = null;
        await _runBestEffort(
          'background progress update',
          () => update(
            progress: progress,
            stage: stage,
            currentItem: currentItem,
            recoverableCheckpointItems: checkpointItems,
          ),
        );
      }
    } finally {
      _bestEffortUpdateInFlight = false;
      if (_hasPendingBestEffortUpdate) {
        _bestEffortUpdateInFlight = true;
        unawaited(_drainBestEffortUpdates());
      }
    }
  }

  /// Bounds non-critical cleanup as one operation so cleanup time cannot grow
  /// with the number of retained frame stores.
  Future<void> runBestEffortCleanup(
    String operation,
    Future<void> Function() action,
  ) =>
      _runBestEffort(operation, action);

  Future<void> _refreshCancellationFlag() async {
    try {
      if (await StackJobStatus.isCancellationRequested(statusPath)) {
        _cancellationRequested = true;
      }
    } on Object {
      // Best-effort; a transient read failure just delays detection.
    }
    _lastCancellationCheckAt = DateTime.now();
  }

  Future<void> update({
    double? progress,
    String? stage,
    int? currentItem,
    int? recoverableCheckpointItems,
  }) async {
    final double previousProgress = _progress;
    final String previousStage = _stage;
    final int previousItem = _currentItem;
    final int previousCheckpointItems = _recoverableCheckpointItems;

    if (progress != null) _progress = progress.clamp(0.0, 1.0).toDouble();
    if (stage != null) _stage = stage;
    if (currentItem != null) {
      _currentItem = currentItem.clamp(0, totalItems).toInt();
    }
    if (recoverableCheckpointItems != null) {
      _recoverableCheckpointItems =
          recoverableCheckpointItems.clamp(0, totalItems).toInt();
    }

    // Piggyback the cancellation-flag refresh on the same throttle as
    // progress publishing — see the field doc comment above for why this
    // isn't checked on every call.
    if (!_cancellationRequested) {
      final DateTime? lastCheck = _lastCancellationCheckAt;
      if (lastCheck == null ||
          DateTime.now().difference(lastCheck) >= _cancellationCheckInterval) {
        await _refreshCancellationFlag();
      }
    }

    // Pixel-processing callbacks can report progress many times per second.
    // Persisting status + WorkManager progress + an Android notification for
    // every callback creates avoidable file I/O and platform/Binder traffic,
    // which can starve the UI enough for Android to raise an ANR while the
    // actual image pipeline is still healthy. Keep in-memory progress exact,
    // but publish routine progress at most once per second. Stage/item changes
    // remain immediate so the user still sees meaningful transitions.
    final DateTime now = DateTime.now();
    final DateTime? last = _lastPublishRequestedAt;
    final bool meaningfulChange = _progress > previousProgress ||
        _stage != previousStage ||
        _currentItem != previousItem ||
        _recoverableCheckpointItems != previousCheckpointItems;
    if (meaningfulChange) {
      _progressEpochMs = now.millisecondsSinceEpoch;
    }
    final bool intervalElapsed =
        last == null || now.difference(last) >= _minimumProgressPublishInterval;
    if (!meaningfulChange && !intervalElapsed) {
      return;
    }
    _lastPublishRequestedAt = now;
    await publish(forcePlatform: meaningfulChange);
  }

  Future<void> publish({
    bool heartbeatOnly = false,
    bool forcePlatform = false,
    // See StackJobStatus._stateRank / writeAtomically's guard comment. True
    // only for the one call (start()) that deliberately claims authority
    // back from an interruptedRecoverable state written by another process;
    // every other call — most importantly the routine heartbeat, which
    // fires from this reporter's own idea of `_state` regardless of what
    // another process may have written to disk since — must not be allowed
    // to downgrade a higher-authority state it does not know about.
    bool allowStateDowngrade = false,
  }) {
    _lastPublishRequestedAt = DateTime.now();
    if (_state == StackJobState.running) _heartbeat++;
    final StackJobStatus snapshot = StackJobStatus(
      state: _state,
      progress: _progress,
      stage: _stage,
      currentItem: _currentItem,
      totalItems: totalItems,
      elapsedSeconds: elapsedSeconds,
      updatedEpochMs: DateTime.now().millisecondsSinceEpoch,
      heartbeat: _heartbeat,
      progressEpochMs: _progressEpochMs,
      outputPath: _state == StackJobState.completed ? outputPath : null,
      error: _error,
      recoverableCheckpointItems: _recoverableCheckpointItems,
      recoveryAttempt: _recoveryAttempt,
      recoveryMaxAttempts: _recoveryMaxAttempts,
      recoveryCause: _recoveryCause,
      lastProcessorExitReason: _lastProcessorExitReason,
      lastProcessorExitTimestampMs: _lastProcessorExitTimestampMs,
    );

    return _enqueueSnapshot(
      snapshot,
      forcePlatform: forcePlatform,
      allowStateDowngrade: allowStateDowngrade,
    );
  }

  Future<void> _enqueueSnapshot(
    StackJobStatus snapshot, {
    required bool forcePlatform,
    required bool allowStateDowngrade,
  }) {
    final Completer<void> waiter = Completer<void>();
    if (_publishInFlight) {
      // Keep only the latest state while an earlier status/platform publish is
      // still in flight. This prevents a slow Binder/file operation from
      // turning one-second progress updates into an ever-growing queue.
      _pendingSnapshot = snapshot;
      _pendingForcePlatform = _pendingForcePlatform || forcePlatform;
      _pendingAllowStateDowngrade =
          _pendingAllowStateDowngrade || allowStateDowngrade;
      _pendingWaiters.add(waiter);
      return waiter.future;
    }
    _publishInFlight = true;
    unawaited(_drainPublishes(
      snapshot,
      forcePlatform,
      allowStateDowngrade,
      <Completer<void>>[waiter],
    ));
    return waiter.future;
  }

  Future<void> _drainPublishes(
    StackJobStatus firstSnapshot,
    bool firstForcePlatform,
    bool firstAllowStateDowngrade,
    List<Completer<void>> firstWaiters,
  ) async {
    StackJobStatus snapshot = firstSnapshot;
    bool forcePlatform = firstForcePlatform;
    bool allowStateDowngrade = firstAllowStateDowngrade;
    List<Completer<void>> waiters = firstWaiters;
    try {
      while (true) {
        Object? failure;
        StackTrace? failureStack;
        try {
          await _publishSnapshot(
            snapshot,
            forcePlatform: forcePlatform,
            allowStateDowngrade: allowStateDowngrade,
          );
        } on Object catch (error, stackTrace) {
          failure = error;
          failureStack = stackTrace;
        }
        for (final Completer<void> waiter in waiters) {
          if (waiter.isCompleted) continue;
          if (failure == null) {
            waiter.complete();
          } else {
            waiter.completeError(failure, failureStack!);
          }
        }

        final StackJobStatus? pending = _pendingSnapshot;
        if (pending == null) break;
        snapshot = pending;
        forcePlatform = _pendingForcePlatform;
        allowStateDowngrade = _pendingAllowStateDowngrade;
        waiters = List<Completer<void>>.of(_pendingWaiters);
        _pendingSnapshot = null;
        _pendingForcePlatform = false;
        _pendingAllowStateDowngrade = false;
        _pendingWaiters.clear();
      }
    } finally {
      _publishInFlight = false;
      // A new request can land between the final pending check above and this
      // flag change. If that happened, take ownership of it now instead of
      // leaving its waiter unresolved.
      final StackJobStatus? pending = _pendingSnapshot;
      if (pending != null) {
        final bool pendingForce = _pendingForcePlatform;
        final bool pendingAllowStateDowngrade = _pendingAllowStateDowngrade;
        final List<Completer<void>> pendingWaiters =
            List<Completer<void>>.of(_pendingWaiters);
        _pendingSnapshot = null;
        _pendingForcePlatform = false;
        _pendingAllowStateDowngrade = false;
        _pendingWaiters.clear();
        _publishInFlight = true;
        unawaited(_drainPublishes(
          pending,
          pendingForce,
          pendingAllowStateDowngrade,
          pendingWaiters,
        ));
      }
    }
  }

  Future<void> _publishSnapshot(
    StackJobStatus snapshot, {
    required bool forcePlatform,
    required bool allowStateDowngrade,
  }) async {
    // The status file is the authoritative proof-of-life record and remains
    // available to the one-second UI poll even when platform traffic is
    // intentionally less frequent.
    final int expectedRevision = _revision;
    final StackJobStatus committed =
        await snapshot.copyWith(revision: _revision).writeAtomically(
              statusPath,
              allowStateDowngrade: allowStateDowngrade,
            );
    _revision = committed.revision;
    _recoveryAttempt = committed.recoveryAttempt;
    _recoveryMaxAttempts = committed.recoveryMaxAttempts;
    _recoveryCause = committed.recoveryCause;
    _lastProcessorExitReason = committed.lastProcessorExitReason;
    _lastProcessorExitTimestampMs = committed.lastProcessorExitTimestampMs;
    if (committed.state != snapshot.state) {
      _state = committed.state;
      _heartbeatTimer?.cancel();
      // A denied/stale running publish must not emit a running notification
      // after another writer durably paused or completed this job.
      return;
    }
    if (committed.revision != expectedRevision + 1 ||
        committed.updatedEpochMs != snapshot.updatedEpochMs) {
      return;
    }

    final DateTime now = DateTime.now();
    final DateTime? lastPlatform = _lastPlatformPublishAt;
    final bool platformDue = forcePlatform ||
        lastPlatform == null ||
        now.difference(lastPlatform) >= _minimumPlatformPublishInterval;
    if (!platformDue) return;
    _lastPlatformPublishAt = now;

    // Progress forwarding and notifications are best-effort. A denied
    // notification permission must never abort a highest-quality stack.
    if (workManagerHosted) {
      try {
        await Workmanager().reportProgress(snapshot.toMap()).timeout(
              _platformCallTimeout,
            );
      } on Object {
        // Keep processing; the persisted heartbeat remains authoritative.
      }
    }
    if (snapshot.state == StackJobState.running) {
      try {
        await StackJobNotifications.showRunning(
          progress: snapshot.progress,
          stage: snapshot.stage,
          currentItem: snapshot.currentItem,
          totalItems: snapshot.totalItems,
          elapsedSeconds: snapshot.elapsedSeconds,
          heartbeat: snapshot.heartbeat,
          statusPath: statusPath,
          jobLabel: jobLabel,
        ).timeout(_platformCallTimeout);
      } on Object {
        // WorkManager's own foreground notification remains as fallback.
      }
    }
  }

  Future<void> complete() async {
    _heartbeatTimer?.cancel();
    _state = StackJobState.completed;
    _progress = 1;
    _stage = '完了';
    _currentItem = totalItems;
    _progressEpochMs = DateTime.now().millisecondsSinceEpoch;
    await publish(forcePlatform: true);
    await _runBestEffort('completion notification', () async {
      final bool? enabled =
          await StackJobNotifications.areNotificationsEnabled();
      await DiagnosticLog.log(
        'completion notification: notificationsEnabled=$enabled',
      );
      await StackJobNotifications.showCompleted(
        elapsedSeconds: elapsedSeconds,
        outputPath: outputPath,
        jobLabel: jobLabel,
        completionMessage: completionMessage,
      );
    });
  }

  /// Persists an unexpected failure while explicitly retaining already
  /// committed checkpoints. The UI can restart only the processor and resume
  /// from those verified checkpoints instead of discarding completed work.

  /// Requests a quality-neutral maintenance recycle of only the Android
  /// `:processor` process after a durable checkpoint has been committed.
  /// A dedicated marker preserves the reason. SupervisorService still applies
  /// its per-checkpoint retry cap so structurally insufficient memory cannot
  /// create an infinite maintenance-restart loop.
  Future<void> requestProcessorMaintenanceRestart(
    String reason, {
    required int checkpointItems,
  }) async {
    _heartbeatTimer?.cancel();
    _state = StackJobState.interruptedRecoverable;
    _stage = 'メモリ解放・処理システム再起動待ち';
    _error = null;
    _recoverableCheckpointItems = checkpointItems.clamp(0, totalItems).toInt();
    _progressEpochMs = DateTime.now().millisecondsSinceEpoch;
    final transitionEpochMs = _progressEpochMs;
    await publish(forcePlatform: true);
    if (!await _ownsRecoverableTransition(
        transitionEpochMs, 'メモリ解放・処理システム再起動待ち')) {
      return;
    }
    final File marker = File('$statusPath.supervisor-maintenance-restart');
    await marker.writeAsString(
      '${DateTime.now().millisecondsSinceEpoch}|$reason',
      flush: true,
    );
    await DiagnosticLog.log('processor maintenance restart requested: $reason');
  }

  /// Persists a recoverable pause that requires a user/environment change
  /// before retrying (for example, freeing device storage). Unlike
  /// [failRecoverable], this deliberately does not write the supervisor
  /// restart marker: immediately restarting cannot fix an unchanged external
  /// resource shortage and would only burn the bounded retry budget.
  Future<void> pauseRecoverable(
    Object error, {
    required int checkpointItems,
    String stage = '中断・再開可能',
  }) async {
    _heartbeatTimer?.cancel();
    _state = StackJobState.interruptedRecoverable;
    _stage = stage;
    _error = '$error';
    _recoverableCheckpointItems = checkpointItems.clamp(0, totalItems).toInt();
    _recoveryCause = 'external-resource-pause';
    _progressEpochMs = DateTime.now().millisecondsSinceEpoch;
    await publish(forcePlatform: true);
    await _runBestEffort('recoverable pause notification', () async {
      await StackJobNotifications.showFailed(
        elapsedSeconds: elapsedSeconds,
        error: '$error',
        jobLabel: jobLabel,
      );
    });
  }

  Future<void> failRecoverable(
    Object error, {
    required int checkpointItems,
  }) async {
    if (error is RawDecodeFailure &&
        error.code == RawDecodeErrorCode.cancelled) {
      await cancel();
      return;
    }
    final disposition = classifyProcessingFailure(error);
    if (disposition == ProcessingFailureDisposition.permanent) {
      await fail(error);
      return;
    }
    if (disposition == ProcessingFailureDisposition.resourcePause) {
      await pauseRecoverable(error,
          checkpointItems: checkpointItems, stage: '資源不足・再開可能');
      return;
    }

    _heartbeatTimer?.cancel();
    _state = StackJobState.interruptedRecoverable;
    _stage = '中断・再開可能';
    _error = '$error';
    _recoverableCheckpointItems = checkpointItems.clamp(0, totalItems).toInt();
    _progressEpochMs = DateTime.now().millisecondsSinceEpoch;
    final transitionEpochMs = _progressEpochMs;
    await publish(forcePlatform: true);
    if (!await _ownsRecoverableTransition(transitionEpochMs, '中断・再開可能')) return;
    // Ask the independent native :supervisor process to perform the restart.
    // The marker is written only after the recoverable status is durable.
    // Its bounded retry ledger prevents a deterministic bad frame/native bug
    // from producing an infinite restart loop.
    try {
      final File marker = File('$statusPath.supervisor-restart');
      await marker.writeAsString(
        DateTime.now().millisecondsSinceEpoch.toString(),
        flush: true,
      );
    } on Object catch (markerError) {
      await DiagnosticLog.log(
        'recoverable failure: supervisor marker write failed: $markerError',
      );
    }
    await _runBestEffort('recoverable failure notification', () async {
      await StackJobNotifications.showFailed(
        elapsedSeconds: elapsedSeconds,
        error: '処理が中断されました。保存済み地点から再開できます。\n$error',
        jobLabel: jobLabel,
      );
    });
  }

  Future<bool> _ownsRecoverableTransition(int epochMs, String stage) async {
    final current = await StackJobStatus.readFile(statusPath);
    return current?.state == StackJobState.interruptedRecoverable &&
        current?.revision == _revision &&
        current?.progressEpochMs == epochMs &&
        current?.stage == stage &&
        current?.recoveryCause != 'external-resource-pause';
  }

  Future<void> fail(Object error) async {
    if (error is RawDecodeFailure &&
        error.code == RawDecodeErrorCode.cancelled) {
      await cancel();
      return;
    }
    if (classifyProcessingFailure(error) ==
        ProcessingFailureDisposition.resourcePause) {
      await pauseRecoverable(error,
          checkpointItems: _recoverableCheckpointItems, stage: '資源不足・再開可能');
      return;
    }

    _heartbeatTimer?.cancel();
    _state = StackJobState.failed;
    _stage = 'エラー';
    _error = '$error';
    _progressEpochMs = DateTime.now().millisecondsSinceEpoch;
    await publish(forcePlatform: true);
    await _runBestEffort('failure notification', () async {
      await StackJobNotifications.showFailed(
        elapsedSeconds: elapsedSeconds,
        error: '$error',
        jobLabel: jobLabel,
      );
    });
  }

  /// Terminal state for a job the person explicitly stopped via the "中止"
  /// button, as opposed to [fail] (an unexpected error). Deliberately a
  /// quiet notification rather than [StackJobNotifications.showFailed]'s
  /// alarm-toned one — stopping on purpose isn't a problem to be alerted
  /// about.
  Future<void> cancel() async {
    _heartbeatTimer?.cancel();
    _state = StackJobState.cancelled;
    _stage = '中止済み';
    _progressEpochMs = DateTime.now().millisecondsSinceEpoch;
    await publish(forcePlatform: true);
    await _runBestEffort('cancellation notification', () async {
      await StackJobNotifications.showTaskCompleted(
        jobLabel: jobLabel,
        message:
            '処理を中止しました  経過 ${StackJobNotifications.formatElapsed(elapsedSeconds)}',
      );
    });
  }

  Future<void> dispose() async {
    _heartbeatTimer?.cancel();
    await _runBestEffort(
      'cancellation marker cleanup',
      () => StackJobStatus.clearCancellationRequest(statusPath),
    );
  }
}
