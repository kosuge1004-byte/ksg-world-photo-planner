import 'dart:async';
import 'dart:collection';

import 'concurrency_policy.dart';
import 'processing_job.dart';
import 'resource_snapshot.dart';

typedef JobExecutor = Future<void> Function(
  ProcessingJob job,
  void Function(double progress) reportProgress,
);
typedef ResourceReader = Future<ResourceSnapshot> Function();

/// Inactivity watchdog for one full-resolution RAW frame. Native decode and
/// highest-quality demosaic can legitimately spend several minutes inside one
/// call without a Dart progress callback, especially under Pixel thermal
/// throttling. Thirty minutes still converts a genuine native hang into a
/// visible error without terminating healthy maximum-quality work.
const Duration fullFrameRawStallTimeout = Duration(minutes: 30);

class JobSchedulerSnapshot {
  const JobSchedulerSnapshot({
    required this.queuedCount,
    required this.activeCount,
    required this.completedCount,
    required this.failedCount,
    required this.cancelledCount,
    required this.overallProgress,
  });

  final int queuedCount;
  final int activeCount;
  final int completedCount;
  final int failedCount;
  final int cancelledCount;
  final double overallProgress;

  bool get isFinished => queuedCount == 0 && activeCount == 0;
}

class JobScheduler {
  JobScheduler({
    required this.executor,
    required this.resourceReader,
    this.policy = const ConcurrencyPolicy(),
    this.jobTimeout,
    this.resourceReadTimeout = const Duration(seconds: 15),
  });

  final JobExecutor executor;
  final ResourceReader resourceReader;
  final ConcurrencyPolicy policy;

  /// Upper bound on how long a job may make no forward progress before it is
  /// treated as stalled and failed with a [TimeoutException]. Every increasing
  /// progress report resets this watchdog, so a slow but healthy RAW decode is
  /// no longer rejected merely because its total runtime exceeds this value.
  ///
  /// `null` (the default, and what every pre-existing caller/test still
  /// gets) disables the timeout entirely — behavior is unchanged. Screens
  /// that run long native RAW decode/export jobs opt in explicitly so a
  /// stuck native call surfaces as a clear failure instead of leaving the
  /// scheduler's `activeCount` at 1 forever, which previously made
  /// `isFinished` stay false indefinitely and froze the UI at whatever
  /// percentage the last progress report happened to round to.
  final Duration? jobTimeout;

  /// Prevents a broken platform resource reader from keeping queued work in a
  /// permanent pumping loop. A failure is attached to every queued job so the
  /// caller can converge to its normal terminal/recoverable error path.
  final Duration resourceReadTimeout;

  final Queue<ProcessingJob> _queue = Queue<ProcessingJob>();
  final Set<Future<void>> _active = <Future<void>>{};
  final List<ProcessingJob> _jobs = <ProcessingJob>[];
  final StreamController<JobSchedulerSnapshot> _events =
      StreamController<JobSchedulerSnapshot>.broadcast(sync: true);

  bool _isPumping = false;
  bool _disposed = false;
  bool _poisonedByStall = false;
  Completer<void>? _idleCompleter;

  Stream<JobSchedulerSnapshot> get snapshots => _events.stream;
  List<ProcessingJob> get jobs => List<ProcessingJob>.unmodifiable(_jobs);
  int get queuedCount =>
      _queue.where((ProcessingJob job) => !job.isTerminal).length;
  int get activeCount => _active.length;

  void enqueue(ProcessingJob job) {
    _ensureNotDisposed();
    _jobs.add(job);
    _queue.add(job);
    _idleCompleter ??= Completer<void>();
    _emit();
    unawaited(_pump());
  }

  void enqueueAll(Iterable<ProcessingJob> jobs) {
    for (final ProcessingJob job in jobs) {
      enqueue(job);
    }
  }

  void cancelAll() {
    for (final ProcessingJob job in _jobs) {
      if (!job.isTerminal) job.requestCancellation();
    }
    _queue.removeWhere(
      (ProcessingJob job) => job.state == ProcessingJobState.cancelled,
    );
    _emit();
    _completeIdleIfNeeded();
  }

  Future<void> waitUntilIdle() {
    if (_queue.isEmpty && _active.isEmpty) return Future<void>.value();
    _idleCompleter ??= Completer<void>();
    return _idleCompleter!.future;
  }

  Future<void> dispose() async {
    if (_disposed) return;
    cancelAll();
    await waitUntilIdle();
    _disposed = true;
    await _events.close();
  }

  Future<void> _pump() async {
    if (_isPumping || _disposed) return;
    _isPumping = true;

    try {
      while ((_queue.isNotEmpty || _active.isNotEmpty) && !_disposed) {
        if (_poisonedByStall) {
          while (_queue.isNotEmpty) {
            final ProcessingJob failed = _queue.removeFirst();
            if (failed.isTerminal) continue;
            failed.error = StateError(
              '直前の処理がタイムアウト後も停止を確認できないため、'
              '安全のため後続処理を開始しませんでした。',
            );
            failed.state = ProcessingJobState.failed;
          }
          _emit();
          if (_active.isEmpty) break;
        }
        late final ResourceSnapshot snapshot;
        try {
          snapshot = await resourceReader().timeout(resourceReadTimeout);
        } on Object catch (error, stackTrace) {
          while (_queue.isNotEmpty) {
            final ProcessingJob failed = _queue.removeFirst();
            if (failed.isTerminal) continue;
            failed.error = StateError('端末資源情報を取得できませんでした: $error');
            failed.errorStackTrace = stackTrace;
            failed.state = ProcessingJobState.failed;
          }
          _emit();
          break;
        }
        final int workerLimit = policy.resolveWorkerCount(snapshot);

        while (_queue.isNotEmpty && _active.length < workerLimit) {
          final ProcessingJob job = _queue.removeFirst();
          if (job.state == ProcessingJobState.cancelled) continue;
          // Defer the executor until after the task has been registered in
          // `_active`. `_run()` emits synchronous state/progress snapshots
          // before its first await, so starting it directly here can briefly
          // publish queued=0/active=0 for the last job and falsely report
          // `isFinished == true` while that job is actually running.
          //
          // This race caused the processing screen to enter final-render
          // profile validation before the last RAW had committed its render
          // profile/tile store.
          final Future<void> task = Future<void>.microtask(() => _run(job));
          _active.add(task);
          task.whenComplete(() {
            _active.remove(task);
            _emit();
            _completeIdleIfNeeded();
          });
        }

        _emit();
        if (_active.isNotEmpty) {
          await Future.any(_active);
        }
      }
    } finally {
      _isPumping = false;
      _completeIdleIfNeeded();
      if (_queue.isNotEmpty && !_disposed) unawaited(_pump());
    }
  }

  Future<void> _run(ProcessingJob job) async {
    if (job.cancellationRequested) {
      job.state = ProcessingJobState.cancelled;
      return;
    }

    job.state = ProcessingJobState.running;
    _emit();
    try {
      final Duration? timeout = jobTimeout;
      Timer? watchdog;
      Completer<void>? stalled;
      void armWatchdog() {
        if (timeout == null) return;
        watchdog?.cancel();
        stalled ??= Completer<void>();
        watchdog = Timer(timeout, () {
          if (stalled!.isCompleted) return;
          job.requestCancellation();
          stalled!.completeError(
            TimeoutException(
              '${timeout.inSeconds}秒間、処理の進捗がありませんでした '
              '(${job.sourcePath})。ファイルが壊れているか、端末の '
              'メモリ／ストレージが不足している可能性があります。',
              timeout,
            ),
          );
        });
      }

      final Future<void> run = executor(job, (double progress) {
        if (job.cancellationRequested) return;
        final double next = progress.clamp(0, 1);
        if (next > job.progress) armWatchdog();
        job.progress = next;
        _emit();
      });
      if (timeout == null) {
        await run;
      } else {
        armWatchdog();
        try {
          await Future.any(<Future<void>>[run, stalled!.future]);
        } finally {
          watchdog?.cancel();
        }
      }
      if (job.cancellationRequested) {
        job.state = ProcessingJobState.cancelled;
      } else {
        job.progress = 1;
        job.state = ProcessingJobState.completed;
      }
    } catch (error, stackTrace) {
      // A timeout also flips `cancellationRequested` (best-effort signal to
      // the still-running executor to stop), but it must still surface as a
      // *failure* with the timeout message — not silently as a user
      // cancellation — so check it ahead of the cancellation branch.
      if (error is TimeoutException) {
        // A Dart Future cannot forcibly terminate native/asynchronous work.
        // Poison this scheduler lane so a late-returning executor can never
        // overlap a newly dequeued frame. The Android process watchdog owns
        // the stronger process-level kill/restart boundary.
        _poisonedByStall = true;
        job.error = error;
        job.errorStackTrace = stackTrace;
        job.state = ProcessingJobState.failed;
      } else if (job.cancellationRequested) {
        job.state = ProcessingJobState.cancelled;
      } else {
        job.error = error;
        job.errorStackTrace = stackTrace;
        job.state = ProcessingJobState.failed;
      }
    }
    _emit();
  }

  void _emit() {
    if (_disposed || _events.isClosed) return;
    final int completed = _jobs
        .where((ProcessingJob job) => job.state == ProcessingJobState.completed)
        .length;
    final int failed = _jobs
        .where((ProcessingJob job) => job.state == ProcessingJobState.failed)
        .length;
    final int cancelled = _jobs
        .where((ProcessingJob job) => job.state == ProcessingJobState.cancelled)
        .length;
    final double progress = _jobs.isEmpty
        ? 0
        : _jobs.fold<double>(
              0,
              (double sum, ProcessingJob job) => sum + job.progress,
            ) /
            _jobs.length;

    _events.add(
      JobSchedulerSnapshot(
        queuedCount: queuedCount,
        activeCount: activeCount,
        completedCount: completed,
        failedCount: failed,
        cancelledCount: cancelled,
        overallProgress: progress.clamp(0, 1),
      ),
    );
  }

  void _completeIdleIfNeeded() {
    if (_queue.isEmpty &&
        _active.isEmpty &&
        _idleCompleter != null &&
        !_idleCompleter!.isCompleted) {
      _idleCompleter!.complete();
      _idleCompleter = null;
    }
  }

  void _ensureNotDisposed() {
    if (_disposed) throw StateError('JobSchedulerは破棄されています。');
  }
}
