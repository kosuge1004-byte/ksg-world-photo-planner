import 'dart:ui';

import 'package:flutter/widgets.dart';
import 'package:workmanager/workmanager.dart';

import 'background_task_payload.dart';
import 'cfa_drizzle_background_worker.dart';
import '../raw/native_raw_decoder_factory.dart';
import 'standard_stack_background_worker.dart';
import 'focus_stack_background_worker.dart';
import 'focus_marking_background_worker.dart';
import 'meteor_background_worker.dart';
import 'meteor_composite_background_worker.dart';
import 'stack_job_reporter.dart';
import 'stack_job_stop_persistence.dart';

String? _activeBackgroundStatusPath;

@pragma('vm:entry-point')
void backgroundTaskDispatcher() {
  WidgetsFlutterBinding.ensureInitialized();
  DartPluginRegistrant.ensureInitialized();
  // This headless engine exists solely to run heavy, CPU-bound stack
  // processing — it has no UI of its own to keep responsive, and the
  // foreground Activity (if the person has one open) does. Demoting this
  // engine's own root isolate/thread once, here, before any task runs,
  // means the OS scheduler always prefers the foreground UI thread over
  // this one whenever both want the CPU — not just the specific decode
  // calls that separately demote themselves in ffi_raw_native_bridge.dart,
  // but every stage of every job this engine ever runs (demosaic,
  // tile-store combine, export, anything added later). See
  // lowerCurrentThreadPriorityForBackgroundWork's doc comment for the full
  // rationale.
  lowerCurrentThreadPriorityForBackgroundWork();
  // Work358: this engine is WorkManager-hosted, so progress forwarding to
  // WorkManager is meaningful here (and only here).
  StackJobReporter.workManagerHosted = true;
  Workmanager().executeTask(
    (String task, Map<String, dynamic>? inputData) async {
      if (inputData == null) return false;
      final Map<String, dynamic> resolvedInput =
          await BackgroundTaskPayload.resolve(inputData);
      _activeBackgroundStatusPath = resolvedInput['statusPath'] as String?;
      // AndroidX WorkManager owns the execution wake lock for a running
      // worker. wakelock_plus is intentionally not used here: on Android it
      // controls an Activity window's KEEP_SCREEN_ON flag, not a partial CPU
      // wake lock, and this headless background engine has no Activity.
      try {
        if (task == cfaDrizzleBackgroundTask) {
          return await runCfaDrizzleBackgroundTask(resolvedInput);
        }
        if (task == standardStackBackgroundTask) {
          return await runStandardStackBackgroundTask(resolvedInput);
        }
        if (task == focusStackBackgroundTask) {
          return await runFocusStackBackgroundTask(resolvedInput);
        }
        if (task == focusMarkingBackgroundTask) {
          return await runFocusMarkingBackgroundTask(resolvedInput);
        }
        if (task == meteorBackgroundTask) {
          return await runMeteorBackgroundTask(resolvedInput);
        }
        if (task == meteorCompositeBackgroundTask) {
          return await runMeteorCompositeBackgroundTask(resolvedInput);
        }
        return false;
      } finally {
        _activeBackgroundStatusPath = null;
      }
    },
    onTaskStopped: (String task, StopReason stopReason) async {
      if (task != cfaDrizzleBackgroundTask &&
          task != standardStackBackgroundTask &&
          task != focusStackBackgroundTask &&
          task != focusMarkingBackgroundTask &&
          task != meteorBackgroundTask &&
          task != meteorCompositeBackgroundTask) {
        return;
      }
      final String? statusPath = _activeBackgroundStatusPath;
      if (statusPath == null || statusPath.isEmpty) return;
      await persistStoppedStackJob(
        statusPath: statusPath,
        reason: stopReason.name,
      );
    },
  );
}
