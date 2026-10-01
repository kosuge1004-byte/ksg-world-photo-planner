import 'package:flutter/material.dart';
import 'package:workmanager/workmanager.dart';

import 'app.dart';
import 'core/background/background_task_dispatcher.dart';
// Keeps the alternate :processor Dart entrypoint in the AOT snapshot.
import 'core/background/processor_runtime.dart';
import 'core/background/stack_job_notifications.dart';

// AOT retention anchor for the alternate native-launched Dart entrypoint.
// ignore: unused_element
final Object _processorEntrypointRetention = processorMain;

const Duration _startupInitializationTimeout = Duration(seconds: 10);

Future<void> _initializeBestEffort(
  String name,
  Future<void> Function() initialize,
) async {
  try {
    await initialize().timeout(_startupInitializationTimeout);
  } on Object catch (error, stackTrace) {
    // A platform-plugin failure must not prevent the first Flutter frame from
    // ever being rendered. Feature-level calls still surface actionable errors
    // if the corresponding service is unavailable.
    FlutterError.reportError(FlutterErrorDetails(
      exception: error,
      stack: stackTrace,
      library: 'mobile_stack startup',
      context: ErrorDescription('$name initialization'),
    ));
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Future.wait(<Future<void>>[
    _initializeBestEffort(
      'Workmanager',
      () => Workmanager().initialize(backgroundTaskDispatcher),
    ),
    _initializeBestEffort(
      'notifications',
      StackJobNotifications.initialize,
    ),
  ]);
  runApp(const MobileStackApp());
}
