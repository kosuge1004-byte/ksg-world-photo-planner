import 'native_operation_trace.dart';
import 'dart:async';
import 'dart:isolate';
import 'dart:io';

import 'package:flutter/services.dart';

import '../diagnostics/diagnostic_log.dart';
import 'stack_job_notifications.dart';
import 'stack_job_status.dart';

/// Runs [body] with an independent, external stall watchdog for the
/// background job persisting its status to [statusPath].
///
/// ## Why this exists
/// Every timeout mechanism added so far (`JobScheduler.jobTimeout`, the
/// per-call `DiagnosticLog` heartbeats) is a Dart `Timer` living on the
/// *same isolate* that also runs the actual work. That was enough to catch
/// a hang in one specific native call (RAW decode) once that call was moved
/// off the isolate hosting the timer — but the same isolate-sharing problem
/// exists at every other synchronous native call site in the pipeline
/// (demosaic tile processing, tile-store combine/export, …), most of which
/// report progress frequently enough that a single slow call is invisible,
/// right up until the one call that doesn't return. Fixing each call site
/// individually means every *future* native call site added to the
/// pipeline inherits the same latent risk unless someone remembers to wrap
/// it too.
///
/// A watchdog that lives on a genuinely separate isolate sidesteps this
/// entirely: it doesn't matter which native call is stuck or why, because
/// it never shares an event loop with whatever is stuck. It has no
/// visibility into *why* something stalled (that's what the per-call
/// `DiagnosticLog` markers are for), only that the job's persisted status
/// stopped advancing — which is true regardless of where in the pipeline
/// the stall happens.
///
/// ## What it does
/// Spawns a monitor isolate that wakes up every [pollInterval] and reads
/// [statusPath]. If the job is still `queued`/`running` but
/// `progressEpochMs` hasn't advanced in at least [staleThreshold], the
/// monitor writes an `interruptedRecoverable` status and asks the independent
/// native supervisor for a bounded processor restart. Once [body] returns (by any
/// means — success or exception), the monitor isolate is killed
/// immediately; a job that finishes normally never triggers it.
///
/// This does not, and cannot, forcibly interrupt whatever native call is
/// actually stuck — Dart cannot preempt a blocking synchronous FFI call from
/// outside its isolate. The supervisor therefore terminates only the processor
/// process and resumes from its durable checkpoint, subject to its retry cap.
Future<T> runWithExternalStallWatchdog<T>({
  required String statusPath,
  required String jobLabel,
  required Future<T> Function() body,
  Duration staleThreshold = const Duration(minutes: 30),
  Duration pollInterval = const Duration(minutes: 1),
}) async {
  RootIsolateToken? rootIsolateToken;
  try {
    rootIsolateToken = ServicesBinding.rootIsolateToken;
  } on Object {
    // If unavailable (e.g. under a test harness with no Flutter binding),
    // the monitor simply won't be able to post a notification — it still
    // performs the file-based stall detection, which needs no plugins.
  }

  final ReceivePort exitPort = ReceivePort();
  final Isolate monitor = await Isolate.spawn(
    _monitorEntry,
    _MonitorConfig(
      statusPath: statusPath,
      jobLabel: jobLabel,
      staleThreshold: staleThreshold,
      pollInterval: pollInterval,
      rootIsolateToken: rootIsolateToken,
    ),
    onExit: exitPort.sendPort,
  );
  try {
    return await runZoned(body, zoneValues: <Object, Object?>{
      nativeOperationStatusPath: statusPath,
      nativeOperationGeometry: <String, (int, int)>{}
    });
  } finally {
    monitor.kill(priority: Isolate.immediate);
    exitPort.close();
  }
}

class _MonitorConfig {
  const _MonitorConfig({
    required this.statusPath,
    required this.jobLabel,
    required this.staleThreshold,
    required this.pollInterval,
    required this.rootIsolateToken,
  });

  final String statusPath;
  final String jobLabel;
  final Duration staleThreshold;
  final Duration pollInterval;
  final RootIsolateToken? rootIsolateToken;
}

void _monitorEntry(_MonitorConfig config) {
  // Registers this isolate for platform-channel use (path_provider is not
  // needed here since statusPath is already an absolute path, but
  // flutter_local_notifications is). Skipped if no token was available —
  // the notification attempt below will then simply fail and be logged,
  // stall detection itself is unaffected.
  final RootIsolateToken? token = config.rootIsolateToken;
  if (token != null) {
    BackgroundIsolateBinaryMessenger.ensureInitialized(token);
  }

  unawaited(_watch(config));
}

Future<void> _watch(_MonitorConfig config) async {
  int? missingSinceEpochMs;
  while (true) {
    await Future<void>.delayed(config.pollInterval);
    try {
      final StackJobStatus? status =
          await StackJobStatus.readFile(config.statusPath);
      if (status == null) {
        final int nowMs = DateTime.now().millisecondsSinceEpoch;
        missingSinceEpochMs ??= nowMs;
        if (nowMs - missingSinceEpochMs <
            config.staleThreshold.inMilliseconds) {
          continue;
        }
        final StackJobStatus missingStatus = StackJobStatus(
          state: StackJobState.interruptedRecoverable,
          progress: 0,
          stage: '処理状態ファイル破損・自動復旧待ち',
          currentItem: 0,
          totalItems: 0,
          elapsedSeconds: 0,
          updatedEpochMs: nowMs,
          progressEpochMs: nowMs,
          heartbeat: 0,
          error: '外部監視: 処理状態ファイルを長時間読み取れませんでした。',
        );
        await missingStatus.writeAtomically(config.statusPath);
        await File('${config.statusPath}.supervisor-restart').writeAsString(
          nowMs.toString(),
          flush: true,
        );
        return;
      }
      missingSinceEpochMs = null;
      if (status.state != StackJobState.queued &&
          status.state != StackJobState.running) {
        // Finished by the normal path (or something else already marked it
        // terminal). Nothing left for this monitor to do.
        return;
      }
      final int lastProgressMs = status.progressEpochMs > 0
          ? status.progressEpochMs
          : status.updatedEpochMs;
      final int ageMs = DateTime.now().millisecondsSinceEpoch - lastProgressMs;
      if (ageMs < config.staleThreshold.inMilliseconds) continue;

      await DiagnosticLog.log(
        'external watchdog: stall detected for ${config.jobLabel}, '
        'age=${ageMs ~/ 1000}s (threshold=${config.staleThreshold.inSeconds}s) '
        '— requesting processor restart',
      );
      final StackJobStatus stalled = status.copyWith(
        state: StackJobState.interruptedRecoverable,
        stage: '処理システム応答停止・自動復旧待ち',
        updatedEpochMs: DateTime.now().millisecondsSinceEpoch,
        progressEpochMs: DateTime.now().millisecondsSinceEpoch,
        error: '外部監視: ${config.staleThreshold.inMinutes}分間、進捗が更新されませんでした。'
            '処理内部で応答が止まった可能性があります。',
        clearOutputPath: true,
      );
      final StackJobStatus committed =
          await stalled.writeAtomically(config.statusPath);
      // A heartbeat or completion can advance the revision after our read.
      // Request a restart only for the transition this monitor committed.
      if (committed.revision != status.revision + 1 ||
          committed.state != StackJobState.interruptedRecoverable ||
          committed.updatedEpochMs != stalled.updatedEpochMs) {
        continue;
      }
      // This tiny file is intentionally the cross-process restart request.
      // The watchdog isolate cannot safely kill its own processor process,
      // while the native :supervisor process can. Write it only after the
      // recoverable status is durable so a restarted processor never observes
      // an ambiguous half-transition.
      try {
        final File marker = File('${config.statusPath}.supervisor-restart');
        await marker.writeAsString(
          DateTime.now().millisecondsSinceEpoch.toString(),
          flush: true,
        );
      } on Object catch (error) {
        await DiagnosticLog.log(
          'external watchdog: supervisor marker write failed: $error',
        );
      }
      try {
        await StackJobNotifications.showRecovering(
          elapsedSeconds: status.elapsedSeconds,
          jobLabel: config.jobLabel,
        );
      } on Object catch (error) {
        await DiagnosticLog.log(
          'external watchdog: recovery notification failed: $error',
        );
      }
      return;
    } on Object catch (error) {
      await DiagnosticLog.log('external watchdog: poll error: $error');
      // Keep watching — a transient file-read error is not proof the job
      // itself is unhealthy.
    }
  }
}
