import 'dart:io';

import 'package:flutter/services.dart';

/// Android-only bridge that starts the heavy image processor in a dedicated
/// OS process (`:processor`).  The foreground Flutter/UI process never hosts
/// RAW decode, demosaic, stacking, or export work when this bridge is used.
final class RemoteProcessorBridge {
  RemoteProcessorBridge._();

  static const MethodChannel _channel =
      MethodChannel('com.mobilestack.app/processor_control');

  static Future<void> start({
    required String taskName,
    required String payloadPath,
    required String statusPath,
    required String uniqueName,
    required String jobId,
  }) async {
    if (!Platform.isAndroid) {
      throw UnsupportedError('Remote processor is Android-only.');
    }
    await _channel.invokeMethod<void>('startProcessor', <String, Object>{
      'taskName': taskName,
      'payloadPath': payloadPath,
      'statusPath': statusPath,
      'uniqueName': uniqueName,
      'jobId': jobId,
    });
  }

  /// Restarts only the processing process. The UI process is intentionally
  /// left untouched. The existing payload/status/checkpoints are reused.
  static Future<void> restart({
    required String taskName,
    required String payloadPath,
    required String statusPath,
    required String uniqueName,
    required String jobId,
  }) async {
    if (!Platform.isAndroid) {
      throw UnsupportedError('Remote processor is Android-only.');
    }
    await _channel.invokeMethod<void>('restartProcessor', <String, Object>{
      'taskName': taskName,
      'payloadPath': payloadPath,
      'statusPath': statusPath,
      'uniqueName': uniqueName,
      'jobId': jobId,
    });
  }

  static Future<void> abandon({
    required String statusPath,
    required String jobId,
  }) async {
    if (!Platform.isAndroid) return;
    await _channel.invokeMethod<void>('abandonProcessor', <String, Object>{
      'statusPath': statusPath,
      'jobId': jobId,
    }).timeout(const Duration(seconds: 10));
  }
}
