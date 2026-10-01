import 'dart:io';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../diagnostics/diagnostic_log.dart';

final class StackJobNotifications {
  StackJobNotifications._();

  static const int notificationId = 41001;
  static const String channelId = 'stack_processing';
  static const String channelName = 'スタック処理';
  // Separate from [channelId] on purpose: Android notification channels are
  // immutable after first creation — whichever `importance` the channel was
  // *first* created with sticks for its lifetime, regardless of what later
  // calls on the same channel ID request. [showRunning] always runs first
  // (as soon as a job starts) and creates [channelId] at `Importance.low`
  // (correct for a silent, non-interrupting progress notification). If
  // [showCompleted]/[showFailed] reused that same channel ID, their
  // `Importance.high` would be silently ignored — the notification would
  // still show up in the shade, but with none of the heads-up/sound that
  // `Importance.high` is meant to provide, likely why it can look like it
  // "didn't arrive" even when it technically did.
  static const String completionChannelId = 'stack_processing_result';
  static const String completionChannelName = 'スタック処理 完了/失敗';
  static final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  static bool _initialized = false;

  static Future<void> initialize() async {
    if (_initialized) return;
    const DarwinInitializationSettings darwin = DarwinInitializationSettings(
      requestAlertPermission: false,
      requestBadgePermission: false,
      requestSoundPermission: false,
    );
    const InitializationSettings settings = InitializationSettings(
      android: AndroidInitializationSettings('ic_launcher'),
      iOS: darwin,
      macOS: darwin,
    );
    await _plugin.initialize(settings: settings);
    _initialized = true;
  }

  /// Best-effort read of whether the OS will actually surface notifications
  /// from this app right now. `null` means unknown (non-Android, or the
  /// platform call itself failed) rather than "disabled" — callers should
  /// treat that as inconclusive, not as a confirmed problem.
  ///
  /// This exists purely for diagnostics: a `.show()` call that succeeds from
  /// Flutter's point of view is not proof the person actually saw anything —
  /// Android silently drops notifications when permission is missing, with
  /// no exception on our side. Logging this value at the moments that
  /// matter (job start, completion) turns "the completion notification
  /// never arrived" from a mystery into a one-line answer.
  static Future<bool?> areNotificationsEnabled() async {
    if (!Platform.isAndroid) return null;
    try {
      await initialize();
      return await _plugin
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.areNotificationsEnabled();
    } on Object {
      return null;
    }
  }

  static Future<void> requestPermission() async {
    if (!Platform.isAndroid) return;
    bool? granted;
    Object? failure;
    try {
      await initialize().timeout(const Duration(seconds: 10));
      granted = await _plugin
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.requestNotificationsPermission()
          .timeout(const Duration(seconds: 30));
    } on Object catch (error) {
      // Processing can still run when notification permission is denied or the
      // platform channel is unavailable. Never strand the start flow here.
      failure = error;
    } finally {
      // If the person backgrounds the app while this OS permission dialog
      // is still up (or before it has a chance to render), the dialog can
      // get auto-dismissed/denied depending on Android version/OEM — with
      // no error on our side, since this call simply returns `false`/`null`
      // rather than throwing. Logging the outcome here is the only way to
      // later tell "permission was never actually granted" apart from
      // "permission was granted but the notification still didn't show".
      try {
        await DiagnosticLog.log(
          'notification permission request result=$granted'
          '${failure == null ? '' : ' failure=$failure'}',
        ).timeout(const Duration(seconds: 5));
      } on Object {
        // Diagnostics must not become another job-start dependency.
      }
    }
  }

  static String formatElapsed(int elapsedSeconds) {
    final int hours = elapsedSeconds ~/ 3600;
    final int minutes = (elapsedSeconds % 3600) ~/ 60;
    final int seconds = elapsedSeconds % 60;
    if (hours > 0) {
      return '${hours.toString().padLeft(2, '0')}:'
          '${minutes.toString().padLeft(2, '0')}:'
          '${seconds.toString().padLeft(2, '0')}';
    }
    return '${minutes.toString().padLeft(2, '0')}:'
        '${seconds.toString().padLeft(2, '0')}';
  }

  static Future<void> showRunning({
    required double progress,
    required String stage,
    required int currentItem,
    required int totalItems,
    required int elapsedSeconds,
    required int heartbeat,
    required String statusPath,
    String jobLabel = '天の川スタック',
  }) async {
    await initialize();
    final int percent = (progress.clamp(0.0, 1.0) * 100).round();
    final String count = totalItems > 0 ? '  $currentItem/$totalItems' : '';
    final String body =
        '$stage$count  経過 ${formatElapsed(elapsedSeconds)}  稼働中 #$heartbeat';
    final AndroidNotificationDetails android = AndroidNotificationDetails(
      channelId,
      channelName,
      channelDescription: '長時間の画像処理の進捗を表示します',
      importance: Importance.low,
      priority: Priority.low,
      ongoing: true,
      autoCancel: false,
      onlyAlertOnce: true,
      showProgress: true,
      maxProgress: 100,
      progress: percent,
    );
    await _plugin.show(
      id: notificationId,
      title: '$jobLabel $percent%',
      body: body,
      notificationDetails: NotificationDetails(android: android),
      payload: statusPath,
    );
  }

  static Future<void> showCompleted({
    required int elapsedSeconds,
    required String outputPath,
    String jobLabel = '天の川スタック',
    String? completionMessage,
  }) async {
    await initialize();
    final AndroidNotificationDetails android = AndroidNotificationDetails(
      completionChannelId,
      completionChannelName,
      channelDescription: '長時間の画像処理の完了・失敗を通知します',
      importance: Importance.high,
      priority: Priority.high,
      ongoing: false,
      autoCancel: true,
    );
    await _plugin.show(
      id: notificationId,
      title: '$jobLabel 完了',
      body:
          completionMessage ?? '処理が完了しました  経過 ${formatElapsed(elapsedSeconds)}',
      notificationDetails: NotificationDetails(android: android),
      payload: outputPath,
    );
  }

  static Future<void> showRecovering({
    required int elapsedSeconds,
    String jobLabel = '天の川スタック',
  }) async {
    await initialize();
    final AndroidNotificationDetails android = AndroidNotificationDetails(
      channelId,
      channelName,
      channelDescription: '長時間の画像処理の進捗を表示します',
      importance: Importance.low,
      priority: Priority.low,
      ongoing: true,
      autoCancel: false,
      onlyAlertOnce: true,
    );
    await _plugin.show(
      id: notificationId,
      title: '$jobLabel 自動復旧中',
      body: '処理システムを再起動して保存済み地点から続行します  経過 ${formatElapsed(elapsedSeconds)}',
      notificationDetails: NotificationDetails(android: android),
    );
  }

  static Future<void> showFailed({
    required int elapsedSeconds,
    required String error,
    String jobLabel = '天の川スタック',
  }) async {
    await initialize();
    final AndroidNotificationDetails android = AndroidNotificationDetails(
      completionChannelId,
      completionChannelName,
      channelDescription: '長時間の画像処理の完了・失敗を通知します',
      importance: Importance.high,
      priority: Priority.high,
      ongoing: false,
      autoCancel: true,
    );
    await _plugin.show(
      id: notificationId,
      title: '$jobLabel 失敗',
      body: '処理を停止しました  経過 ${formatElapsed(elapsedSeconds)}',
      notificationDetails: NotificationDetails(android: android),
    );
  }

  static Future<void> showTaskCompleted({
    required String jobLabel,
    String? message,
  }) async {
    await initialize();
    final AndroidNotificationDetails android = AndroidNotificationDetails(
      completionChannelId,
      completionChannelName,
      channelDescription: '長時間の画像処理の完了・失敗を通知します',
      importance: Importance.high,
      priority: Priority.high,
      ongoing: false,
      autoCancel: true,
    );
    await _plugin.show(
      id: notificationId,
      title: '$jobLabel 完了',
      body: message ?? '処理が完了しました',
      notificationDetails: NotificationDetails(android: android),
    );
  }
}
