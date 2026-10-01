import 'dart:async';
import 'dart:io';

import 'background_stack_controller.dart';
import 'stack_job_registry.dart';
import 'stack_job_status.dart';

/// Single authority for Android foreground-service timeout recovery.
///
/// Android does not allow an exhausted mediaProcessing foreground-service
/// budget to be bypassed while the app remains backgrounded. Once the user
/// returns the Activity to foreground, this coordinator restarts the isolated
/// processor exactly once from the already-persisted payload/checkpoints.
final class ForegroundTimeoutRecovery {
  ForegroundTimeoutRecovery._();

  static Future<bool>? _inFlight;

  /// Recovery causes this coordinator is willing to retry automatically.
  ///
  /// - 'foreground-service-timeout': Android's mediaProcessing FGS time
  ///   budget was exhausted while backgrounded (Work328).
  /// - 'processor-restart-fgs-denied': a *restart* attempt (e.g. the user's
  ///   manual "処理システムだけ再起動して続行" for a hung processor) itself
  ///   failed to launch and was downgraded to this recoverable state by
  ///   MainActivity rather than being left stuck at a stale queued/running
  ///   snapshot forever (Work333).
  /// - 'processor-launch-unconfirmed': Android accepted the service request,
  ///   but the isolated Dart runtime did not acknowledge it before the
  ///   Activity/timeout boundary. Its payload is preserved for a safe retry.
  ///
  /// Both represent the same underlying situation from this coordinator's
  /// point of view: the persisted job is not actually running and needs an
  /// explicit, foregrounded relaunch.
  static const Set<String> recoverableCauses = <String>{
    'foreground-service-timeout',
    'processor-restart-fgs-denied',
    'processor-launch-unconfirmed',
  };

  /// Returns true only when a timeout-recoverable job was found and the
  /// processor restart request was accepted by Android.
  ///
  /// Concurrent lifecycle/UI callers share one in-flight Future, preventing
  /// duplicate restartProcessor calls when multiple mounted screens observe
  /// the same AppLifecycleState.resumed transition.
  static Future<bool> resumeIfNeeded() {
    if (!Platform.isAndroid) return Future<bool>.value(false);
    final Future<bool>? current = _inFlight;
    if (current != null) return current;

    final Future<bool> next = _resumeIfNeededInternal();
    _inFlight = next;
    return next.whenComplete(() {
      if (identical(_inFlight, next)) _inFlight = null;
    });
  }

  static Future<bool> _resumeIfNeededInternal() async {
    // Reconcile any stale queued/running record first, then inspect the
    // durable recoverable generation. This works after ordinary foregrounding
    // as well as a cold UI-process relaunch.
    await StackJobRegistry.activeJob();
    final StackJobRecord? record = await StackJobRegistry.recoverableJob();
    if (record == null) return false;

    final StackJobStatus? status =
        await StackJobStatus.readFile(record.statusPath);
    if (status == null ||
        status.state != StackJobState.interruptedRecoverable ||
        !recoverableCauses.contains(status.recoveryCause)) {
      return false;
    }

    final BackgroundStackLaunch launch = BackgroundStackLaunch(
      uniqueName: record.uniqueName,
      statusPath: record.statusPath,
      outputPath: record.outputPath,
      frameCount: record.frameCount,
      recovered: true,
      jobKind: record.jobKind,
      modeName: record.modeName,
      jobLabel: record.jobLabel,
      sourcePaths: record.sourcePaths,
      outputFormatName: record.outputFormatName,
      storagePresetName: record.storagePresetName,
    );

    await BackgroundStackController.restartProcessor(launch);
    return true;
  }
}
