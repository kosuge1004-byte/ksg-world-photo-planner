import 'dart:async';
import 'dart:ui';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../raw/native_raw_decoder_factory.dart';
import 'background_task_payload.dart';
import 'cfa_drizzle_background_worker.dart';
import 'focus_marking_background_worker.dart';
import 'focus_stack_background_worker.dart';
import 'meteor_background_worker.dart';
import 'meteor_composite_background_worker.dart';
import 'standard_stack_background_worker.dart';

const MethodChannel _processorRuntimeChannel =
    MethodChannel('com.mobilestack.app/processor_runtime');

/// Entry point for the Android `:processor` process.
///
/// This is deliberately separate from [main] and WorkManager's headless
/// callback.  A native foreground Service creates a FlutterEngine inside the
/// dedicated process and launches only this entry point.  Therefore a stuck
/// native RAW call, processor GC pressure, or a processor-process ANR does not
/// share the UI process/VM heap/main looper.
@pragma('vm:entry-point')
Future<void> processorMain() async {
  WidgetsFlutterBinding.ensureInitialized();
  DartPluginRegistrant.ensureInitialized();
  lowerCurrentThreadPriorityForBackgroundWork();

  _processorRuntimeChannel.setMethodCallHandler((MethodCall call) async {
    if (call.method != 'execute') {
      throw MissingPluginException('Unknown processor method: ${call.method}');
    }
    final Object? rawArguments = call.arguments;
    if (rawArguments is! Map) {
      throw ArgumentError('Processor arguments are missing.');
    }
    final String? taskName = rawArguments['taskName'] as String?;
    final String? payloadPath = rawArguments['payloadPath'] as String?;
    final String? statusPath = rawArguments['statusPath'] as String?;
    if (taskName == null ||
        taskName.isEmpty ||
        payloadPath == null ||
        payloadPath.isEmpty) {
      throw ArgumentError('Processor taskName/payloadPath is missing.');
    }

    final Map<String, dynamic> resolvedInput =
        await BackgroundTaskPayload.resolve(<String, dynamic>{
      BackgroundTaskPayload.inputDataKey: payloadPath,
      if (statusPath != null && statusPath.isNotEmpty) 'statusPath': statusPath,
    });

    if (taskName == cfaDrizzleBackgroundTask) {
      return runCfaDrizzleBackgroundTask(resolvedInput);
    }
    if (taskName == standardStackBackgroundTask) {
      return runStandardStackBackgroundTask(resolvedInput);
    }
    if (taskName == focusStackBackgroundTask) {
      return runFocusStackBackgroundTask(resolvedInput);
    }
    if (taskName == focusMarkingBackgroundTask) {
      return runFocusMarkingBackgroundTask(resolvedInput);
    }
    if (taskName == meteorBackgroundTask) {
      return runMeteorBackgroundTask(resolvedInput);
    }
    if (taskName == meteorCompositeBackgroundTask) {
      return runMeteorCompositeBackgroundTask(resolvedInput);
    }
    throw ArgumentError('Unknown processor task: $taskName');
  });

  // Native side does not dispatch the long-running call until this handshake
  // arrives, closing the cold-engine race where a MethodChannel message could
  // otherwise be sent before Dart installed its handler.
  await _processorRuntimeChannel.invokeMethod<void>('runtimeReady');

  // Keep this root isolate alive for native -> Dart control messages until
  // ProcessorService destroys the dedicated FlutterEngine.
  await Completer<void>().future;
}
