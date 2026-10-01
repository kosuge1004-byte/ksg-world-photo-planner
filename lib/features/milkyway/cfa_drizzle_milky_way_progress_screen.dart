import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/background/background_stack_controller.dart';
import '../../core/background/foreground_timeout_recovery.dart';
import '../../core/background/stack_job_notifications.dart';
import '../../core/background/stack_job_registry.dart';
import '../../core/background/stack_job_status.dart';
import '../../core/models/processing_mode.dart';
import '../../core/session/processing_session.dart';
import '../../design/mobile_stack_theme.dart';
import '../common/result_screen.dart';

/// Long-running CFA Drizzle progress screen.
///
/// The actual highest-quality stack is executed by Android WorkManager as a
/// long-running foreground worker. This widget is only an observer: leaving
/// the app or turning the screen off does not make the image pipeline depend
/// on this widget's lifecycle.
///
/// No ETA is displayed. Progress is proven with a persistent status file,
/// elapsed time, current stage/item and a heartbeat updated every 10 seconds.
class CfaDrizzleMilkyWayProgressScreen extends StatefulWidget {
  const CfaDrizzleMilkyWayProgressScreen({
    required this.session,
    this.darkFramePaths,
    this.flatFramePaths,
    this.enableLocalToneAdaptation = false,
    this.enableRobustRejection = true,
    this.useComprehensiveFrameWeighting = true,
    this.usePsfRefinement = true,
    this.enableLocalRegistration = true,
    this.existingLaunch,
    super.key,
  });

  const CfaDrizzleMilkyWayProgressScreen.resume({
    required BackgroundStackLaunch launch,
    super.key,
  })  : session = null,
        darkFramePaths = null,
        flatFramePaths = null,
        enableLocalToneAdaptation = false,
        enableRobustRejection = true,
        useComprehensiveFrameWeighting = true,
        usePsfRefinement = true,
        enableLocalRegistration = true,
        existingLaunch = launch;

  final ProcessingSession? session;
  final BackgroundStackLaunch? existingLaunch;
  final List<String>? darkFramePaths;
  final List<String>? flatFramePaths;
  final bool enableLocalToneAdaptation;
  final bool enableRobustRejection;
  final bool useComprehensiveFrameWeighting;
  final bool usePsfRefinement;
  final bool enableLocalRegistration;

  @override
  State<CfaDrizzleMilkyWayProgressScreen> createState() =>
      _CfaDrizzleMilkyWayProgressScreenState();
}

class _CfaDrizzleMilkyWayProgressScreenState
    extends State<CfaDrizzleMilkyWayProgressScreen>
    with WidgetsBindingObserver {
  BackgroundStackLaunch? _launch;
  StackJobStatus? _status;
  Timer? _pollTimer;
  Object? _error;
  bool _openedResult = false;
  bool _starting = false;
  bool _restartingProcessor = false;
  bool _autoResumingTimeout = false;
  bool _abandoning = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final BackgroundStackLaunch? existing = widget.existingLaunch;
    if (existing != null) {
      _launch = existing;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        unawaited(_attachToExistingJob());
      });
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        unawaited(_startBackgroundJob());
      });
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _pollTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_resumeAfterPlatformTimeoutThenPoll());
    }
  }

  Future<void> _resumeAfterPlatformTimeoutThenPoll() async {
    if (!Platform.isAndroid || _autoResumingTimeout || _restartingProcessor) {
      await _pollStatus();
      return;
    }
    _autoResumingTimeout = true;
    try {
      await ForegroundTimeoutRecovery.resumeIfNeeded();
    } on Object {
      // The persisted interrupted state remains authoritative and visible;
      // the user can still use the explicit recovery button below if
      // Android rejects the foreground restart for any device-specific
      // reason. Surfacing this transient denial as a dead-end _error here
      // would hide that button behind an unretryable failure screen.
    } finally {
      _autoResumingTimeout = false;
    }
    await _pollStatus();
  }

  /// Android-only: force-restarts the isolated `:processor` process and
  /// reuses the already-persisted payload/status/checkpoints. Used both for
  /// a job Android marked interruptedRecoverable and for one that looks
  /// hung (see _processorUnresponsive in _buildProgress). The native side
  /// retries a transient FGS-start denial on its own; if it still cannot
  /// launch, the job is left (or put back) in interruptedRecoverable so a
  /// later foreground event or another tap here can retry.
  Future<void> _restartProcessor() async {
    final BackgroundStackLaunch? launch = _launch;
    if (!Platform.isAndroid ||
        launch == null ||
        _restartingProcessor ||
        _autoResumingTimeout) {
      return;
    }
    setState(() => _restartingProcessor = true);
    try {
      await BackgroundStackController.restartProcessor(launch);
      if (!mounted) return;
      setState(() {
        _error = null;
        _status = _status?.copyWith(stage: '処理システムを再起動中…');
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _restartingProcessor = false);
    }
  }

  Future<void> _attachToExistingJob() async {
    await _pollStatus();
    if (!mounted) return;
    _pollTimer ??= Timer.periodic(
      const Duration(seconds: 1),
      (_) => unawaited(_pollStatus()),
    );
  }

  Future<void> _startBackgroundJob() async {
    if (_starting || _launch != null) return;
    _starting = true;
    try {
      final ProcessingSession session = widget.session!;
      final BackgroundStackLaunch launch =
          await BackgroundStackController.startCfaDrizzle(
        sourcePaths: <String>[
          for (final file in session.files) file.path,
        ],
        darkFramePaths: widget.darkFramePaths,
        flatFramePaths: widget.flatFramePaths,
        enableRobustRejection: widget.enableRobustRejection,
        useComprehensiveFrameWeighting: widget.useComprehensiveFrameWeighting,
        usePsfRefinement: widget.usePsfRefinement,
        enableLocalRegistration: widget.enableLocalRegistration,
      );
      if (!mounted) return;
      if (!launch.recovered) session.markProcessing();
      setState(() => _launch = launch);
      await _pollStatus();
      _pollTimer = Timer.periodic(
        const Duration(seconds: 1),
        (_) => unawaited(_pollStatus()),
      );
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
      widget.session?.markFailed(error);
    } finally {
      _starting = false;
    }
  }

  Future<void> _pollStatus() async {
    final BackgroundStackLaunch? launch = _launch;
    if (launch == null) return;
    StackJobStatus? status = await StackJobStatus.readFile(launch.statusPath);
    if (status == null) return;

    final int ageSeconds = status.updatedEpochMs <= 0
        ? 0
        : DateTime.now()
            .difference(
              DateTime.fromMillisecondsSinceEpoch(status.updatedEpochMs),
            )
            .inSeconds;
    if ((status.state == StackJobState.queued ||
            status.state == StackJobState.running) &&
        ageSeconds >= 15) {
      // Heartbeats normally arrive every 10 seconds. If they stop, ask the
      // authoritative Android WorkManager state before leaving the UI stuck on
      // a stale `running` snapshot.
      await StackJobRegistry.activeJob();
      status = await StackJobStatus.readFile(launch.statusPath) ?? status;
    }

    if (!mounted) return;
    setState(() => _status = status);

    if ((status.state == StackJobState.queued ||
            status.state == StackJobState.running) &&
        _error != null) {
      // The job genuinely recovered (e.g. an automatic or manual restart
      // succeeded after an earlier interruptedRecoverable/failed reading set
      // _error). Without this, _error is sticky forever and this screen
      // would keep showing "スタック処理に失敗しました" even while the job
      // completes successfully in the background.
      setState(() => _error = null);
    }

    if (status.state == StackJobState.completed &&
        !_openedResult &&
        _error == null) {
      final String outputPath = status.outputPath ?? launch.outputPath;
      final File result = File(outputPath);
      if (!await result.exists()) {
        final StateError error = StateError('完了状態ですがLinear DNG出力が見つかりません。');
        setState(() => _error = error);
        widget.session?.markFailed(error);
        return;
      }
      try {
        _openedResult = true;
        _pollTimer?.cancel();
        widget.session?.markCompleted();
        if (!mounted) return;
        await Navigator.of(context).push<void>(
          MaterialPageRoute<void>(
            builder: (_) => ResultScreen(
              mode: widget.session?.mode ?? ProcessingMode.milkyWay,
              imageFile: result,
              frameCount: launch.frameCount,
              // Background results live in the persistent job directory rather
              // than the ordinary temporary-result directory. Registry cleanup
              // below owns deletion so status/result are removed together.
              deleteTemporaryResultOnDispose: false,
            ),
          ),
        );
        await StackJobRegistry.discardTerminalJob(
          uniqueName: launch.uniqueName,
          statusPath: launch.statusPath,
          outputPath: outputPath,
        );
      } on Object catch (error) {
        _openedResult = false;
        if (mounted) setState(() => _error = error);
      }
    } else if (status.state == StackJobState.interruptedRecoverable &&
        _error == null) {
      final StateError error = StateError(
        status.error ?? '処理が中断されました。再開可能な状態です。',
      );
      setState(() => _error = error);
    } else if (status.state == StackJobState.failed && _error == null) {
      final StateError error = StateError(status.error ?? 'バックグラウンド処理に失敗しました。');
      setState(() => _error = error);
      widget.session?.markFailed(error);
    } else if (status.state == StackJobState.cancelled) {
      if (_abandoning) return;
      _pollTimer?.cancel();
      await StackJobRegistry.discardTerminalJob(
        uniqueName: launch.uniqueName,
        statusPath: launch.statusPath,
        outputPath: launch.outputPath,
      );
      if (mounted) Navigator.of(context).maybePop();
    }
  }

  /// Android-only: mirrors standard_background_progress_screen.dart's same
  /// heuristic. Heartbeats normally arrive every 10 seconds; 15+ seconds of
  /// silence while still claiming queued/running means the isolated
  /// `:processor` process itself may be hung or dead with nothing (e.g. an
  /// unstarted or since-failed Supervisor) currently watching it.
  bool get _processorUnresponsive {
    if (!Platform.isAndroid) return false;
    final StackJobStatus? status = _status;
    if (status == null) return false;
    if (status.state != StackJobState.queued &&
        status.state != StackJobState.running) {
      return false;
    }
    if (status.updatedEpochMs <= 0) return false;
    final int heartbeatAgeSeconds = DateTime.now()
        .difference(DateTime.fromMillisecondsSinceEpoch(status.updatedEpochMs))
        .inSeconds;
    final int lastProgressMs = status.progressEpochMs > 0
        ? status.progressEpochMs
        : status.updatedEpochMs;
    final int progressAgeSeconds = DateTime.now()
        .difference(DateTime.fromMillisecondsSinceEpoch(lastProgressMs))
        .inSeconds;
    return heartbeatAgeSeconds >= 15 || progressAgeSeconds >= 30 * 60;
  }

  bool get _canCancel {
    final StackJobState? state = _status?.state;
    return _launch != null &&
        _error == null &&
        (state == null ||
            state == StackJobState.queued ||
            state == StackJobState.running);
  }

  Future<void> _retryOpeningCompletedResult() async {
    if (_openedResult) return;
    setState(() => _error = null);
    await _pollStatus();
  }

  Future<void> _confirmCancel() async {
    final BackgroundStackLaunch? launch = _launch;
    if (launch == null) return;
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('処理を中止しますか？'),
        content: const Text(
          'ここまでの処理内容は破棄されます。この操作は取り消せません。',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('キャンセル'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('中止する'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await BackgroundStackController.requestCancellation(launch.statusPath);
    if (mounted) {
      setState(() {
        _status = _status?.copyWith(stage: '中止を要求しました…');
      });
    }
  }

  Future<void> _confirmAbandonRecoverableJob() async {
    final BackgroundStackLaunch? launch = _launch;
    if (launch == null) return;
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('この処理を破棄しますか？'),
        content: const Text('保存済みチェックポイントを破棄し、新しい処理を開始できる状態にします。'),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('戻る'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('破棄する'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    _abandoning = true;
    _pollTimer?.cancel();
    try {
      await BackgroundStackController.abandonRecoverableJob(launch);
    } on Object catch (error) {
      _abandoning = false;
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$error')),
        );
      }
      return;
    }
    if (mounted) Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('最高画質スタック'),
        actions: <Widget>[
          if (_canCancel)
            IconButton(
              icon: const Icon(Icons.stop_circle_outlined),
              tooltip: '処理を中止',
              onPressed: _confirmCancel,
            ),
        ],
      ),
      body: StarfieldBackground(
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: _error != null ? _buildError() : _buildProgress(),
          ),
        ),
      ),
    );
  }

  Widget _buildProgress() {
    final StackJobStatus? status = _status;
    final double progress = status?.progress ?? 0;
    final int percent = (progress.clamp(0.0, 1.0) * 100).round();
    final int elapsed = status?.elapsedSeconds ?? 0;
    final int updatedEpochMs = status?.updatedEpochMs ?? 0;
    final int updateAgeSeconds = updatedEpochMs <= 0
        ? 0
        : DateTime.now()
            .difference(
              DateTime.fromMillisecondsSinceEpoch(updatedEpochMs),
            )
            .inSeconds
            .clamp(0, 1 << 31)
            .toInt();
    final String itemCount = (status?.totalItems ?? 0) > 0
        ? '${status!.currentItem} / ${status.totalItems}'
        : '準備中';

    return ListView(
      children: <Widget>[
        const SizedBox(height: 28),
        Text(
          '$percent%',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 36, fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 12),
        ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: LinearProgressIndicator(value: progress, minHeight: 9),
        ),
        const SizedBox(height: 24),
        _StatusRow(
          label: '稼働状態',
          value: _stateLabel(status?.state),
        ),
        _StatusRow(
          label: '現在工程',
          value: status?.stage ?? 'バックグラウンド処理を起動中',
        ),
        _StatusRow(label: '処理枚数', value: itemCount),
        _StatusRow(
          label: '経過時間',
          value: StackJobNotifications.formatElapsed(elapsed),
        ),
        _StatusRow(
          label: '最終更新',
          value: updatedEpochMs <= 0 ? '待機中' : '$updateAgeSeconds秒前',
        ),
        _StatusRow(
          label: '稼働確認（処理番号ではありません）',
          value: '#${status?.heartbeat ?? 0}',
        ),
        if (_processorUnresponsive) ...<Widget>[
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  const Text(
                    '画像処理システムから15秒以上更新がありません。UIは別プロセスのため操作できます。',
                  ),
                  const SizedBox(height: 12),
                  FilledButton.icon(
                    onPressed: (_restartingProcessor || _autoResumingTimeout)
                        ? null
                        : _restartProcessor,
                    icon: const Icon(Icons.restart_alt),
                    label: Text(
                      _restartingProcessor ? '再起動中…' : '処理システムだけ再起動して続行',
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
        const SizedBox(height: 24),
        const Card(
          child: Padding(
            padding: EdgeInsets.all(16),
            child: Text(
              '処理はAndroidの長時間バックグラウンドworkerで実行します。'
              '別のアプリを開いた場合や画面をOFFにした場合も、'
              'この画面とは独立して処理を継続します。\n\n'
              '残り時間は表示しません。進捗率・工程・処理枚数・経過時間・'
              '最終更新・Heartbeatで実際の稼働状態を確認します。',
              style: TextStyle(
                color: MobileStackColors.muted,
                height: 1.5,
              ),
            ),
          ),
        ),
      ],
    );
  }

  String _stateLabel(StackJobState? state) {
    return switch (state) {
      StackJobState.queued => '待機中',
      StackJobState.running => '処理中 ●',
      StackJobState.completed => '完了',
      StackJobState.failed => 'エラー',
      StackJobState.interruptedRecoverable => '中断・再開可能',
      StackJobState.cancelled => 'キャンセル',
      null => '起動中',
    };
  }

  Widget _buildError() {
    final bool recoverable = Platform.isAndroid &&
        _status?.state == StackJobState.interruptedRecoverable;
    return ListView(
      children: <Widget>[
        const SizedBox(height: 40),
        const Icon(Icons.error_outline_rounded, size: 52),
        const SizedBox(height: 16),
        Text(
          recoverable ? '処理が中断しました' : 'スタック処理に失敗しました',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 12),
        Text(
          '$_error',
          textAlign: TextAlign.center,
          style: const TextStyle(color: MobileStackColors.muted),
        ),
        const SizedBox(height: 28),
        if (_status?.state == StackJobState.completed) ...<Widget>[
          FilledButton.icon(
            onPressed: _retryOpeningCompletedResult,
            icon: const Icon(Icons.refresh),
            label: const Text('結果をもう一度開く'),
          ),
          const SizedBox(height: 12),
        ],
        if (recoverable) ...<Widget>[
          FilledButton.icon(
            onPressed: (_restartingProcessor || _autoResumingTimeout)
                ? null
                : _restartProcessor,
            icon: const Icon(Icons.play_arrow),
            label: Text(_restartingProcessor ? '再開中…' : '保存済み地点から再開'),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: _confirmAbandonRecoverableJob,
            icon: const Icon(Icons.delete_outline),
            label: const Text('この処理を破棄'),
          ),
          const SizedBox(height: 12),
        ],
        FilledButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('戻る'),
        ),
      ],
    );
  }
}

final class _StatusRow extends StatelessWidget {
  const _StatusRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 92,
            child: Text(
              label,
              style: const TextStyle(color: MobileStackColors.muted),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}
