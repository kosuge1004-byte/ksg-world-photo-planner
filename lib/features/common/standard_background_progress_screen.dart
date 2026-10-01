import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/background/background_stack_controller.dart';
import '../../core/background/foreground_timeout_recovery.dart';
import '../../core/background/meteor_background_codec.dart';
import '../../core/background/focus_marking_background_codec.dart';
import '../../core/background/stack_job_notifications.dart';
import '../../core/background/stack_job_registry.dart';
import '../../core/background/stack_job_status.dart';
import '../../core/export/dng_final_render_profile.dart';
import '../../core/export/lightroom_storage_preset.dart';
import '../../core/export/output_image_format.dart';
import '../../core/focus_stack/focus_marking_preview_model.dart';
import '../../core/io/raw_input_contract.dart';
import '../../core/models/processing_mode.dart';
import '../../core/raw/native_raw_decoder_factory.dart';
import '../../core/raw/raw_file_probe.dart';
import '../../core/session/meteor_pipeline.dart';
import '../../core/session/processing_session.dart';
import '../../design/mobile_stack_theme.dart';
import '../focus_stack/focus_marking_review_screen.dart';
import '../meteor/meteor_review_screen.dart';
import 'result_screen.dart';

class StandardBackgroundProgressScreen extends StatefulWidget {
  const StandardBackgroundProgressScreen({
    required this.session,
    this.darkFramePaths,
    this.flatFramePaths,
    this.existingLaunch,
    super.key,
  });

  const StandardBackgroundProgressScreen.resume({
    required BackgroundStackLaunch launch,
    super.key,
  })  : session = null,
        darkFramePaths = null,
        flatFramePaths = null,
        existingLaunch = launch;

  final ProcessingSession? session;
  final List<String>? darkFramePaths;
  final List<String>? flatFramePaths;
  final BackgroundStackLaunch? existingLaunch;

  @override
  State<StandardBackgroundProgressScreen> createState() =>
      _StandardBackgroundProgressScreenState();
}

class _StandardBackgroundProgressScreenState
    extends State<StandardBackgroundProgressScreen>
    with WidgetsBindingObserver {
  BackgroundStackLaunch? _launch;
  StackJobStatus? _status;
  Timer? _pollTimer;
  Object? _error;
  bool _openedResult = false;
  bool _starting = false;
  String _startingStage = '開始処理を準備中…';
  bool _restartingProcessor = false;
  bool _autoResumingTimeout = false;
  bool _abandoning = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _launch = widget.existingLaunch;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_launch == null) {
        unawaited(_start());
      } else {
        unawaited(_attach());
      }
    });
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
      unawaited(_resumeAfterPlatformTimeoutIfNeeded());
    }
  }

  Future<void> _start() async {
    if (_starting) return;
    setState(() {
      _starting = true;
      _startingStage = '開始処理を準備中…';
    });
    try {
      final ProcessingSession session = widget.session!;
      final BackgroundStackLaunch launch = session.mode == ProcessingMode.meteor
          ? await BackgroundStackController.startMeteorAnalysis(
              session: session,
              darkFramePaths: widget.darkFramePaths,
              flatFramePaths: widget.flatFramePaths,
              onLaunchStage: _showLaunchStage,
            )
          : await BackgroundStackController.startStandardStack(
              session: session,
              darkFramePaths: widget.darkFramePaths,
              flatFramePaths: widget.flatFramePaths,
              onLaunchStage: _showLaunchStage,
            );
      if (!mounted) return;
      if (!launch.recovered) session.markProcessing();
      setState(() => _launch = launch);
      await _attach();
    } on BackgroundStoragePreflightException catch (error) {
      if (!mounted) return;
      widget.session?.resetToReady();
      setState(() => _error = error);
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
      widget.session?.markFailed(error);
    } finally {
      _starting = false;
    }
  }

  void _showLaunchStage(String stage) {
    if (!mounted || !_starting || stage == _startingStage) return;
    setState(() => _startingStage = stage);
  }

  Future<void> _attach() async {
    await _poll();
    await _resumeAfterPlatformTimeoutIfNeeded();
    if (!mounted) return;
    _pollTimer ??= Timer.periodic(
      const Duration(seconds: 1),
      (_) => unawaited(_poll()),
    );
  }

  ProcessingMode _modeFromLaunch(BackgroundStackLaunch launch) {
    for (final ProcessingMode mode in ProcessingMode.values) {
      if (mode.name == launch.modeName) return mode;
    }
    return ProcessingMode.milkyWay;
  }

  Future<void> _poll() async {
    final BackgroundStackLaunch? launch = _launch;
    if (launch == null) return;
    StackJobStatus? status = await StackJobStatus.readFile(launch.statusPath);
    if (status == null) return;
    final int ageSeconds = status.updatedEpochMs <= 0
        ? 0
        : DateTime.now()
            .difference(
                DateTime.fromMillisecondsSinceEpoch(status.updatedEpochMs))
            .inSeconds;
    if ((status.state == StackJobState.queued ||
            status.state == StackJobState.running) &&
        ageSeconds >= 15) {
      await StackJobRegistry.activeJob();
      status = await StackJobStatus.readFile(launch.statusPath) ?? status;
    }
    if (!mounted) return;
    setState(() => _status = status);
    if ((status.state == StackJobState.queued ||
            status.state == StackJobState.running ||
            status.state == StackJobState.interruptedRecoverable) &&
        _error != null) {
      // A transient restart error must not permanently hide the durable
      // recovery controls while the job is still runnable.
      setState(() => _error = null);
    }
    if (status.state == StackJobState.completed &&
        !_openedResult &&
        _error == null) {
      final String outputPath = status.outputPath ?? launch.outputPath;
      final File output = File(outputPath);
      if (!await output.exists()) {
        final StateError error = StateError('完了状態ですが出力ファイルが見つかりません。');
        setState(() => _error = error);
        widget.session?.markFailed(error);
        return;
      }
      try {
        _openedResult = true;
        _pollTimer?.cancel();
        widget.session?.markCompleted();
        if (!mounted) return;
        if (launch.jobKind == 'focusMarking') {
          final BackgroundStackLaunch? nextLaunch =
              await _openFocusMarkingReview(launch, outputPath);
          if (nextLaunch != null) {
            if (!mounted) return;
            unawaited(Navigator.of(context).pushReplacement<void, void>(
              MaterialPageRoute<void>(
                builder: (_) => StandardBackgroundProgressScreen.resume(
                  launch: nextLaunch,
                ),
              ),
            ));
            return;
          }
        } else if (launch.jobKind == 'meteorAnalysis') {
          final BackgroundStackLaunch? nextLaunch =
              await _openMeteorReview(launch, outputPath);
          if (nextLaunch != null) {
            if (!mounted) return;
            unawaited(Navigator.of(context).pushReplacement<void, void>(
              MaterialPageRoute<void>(
                builder: (_) => StandardBackgroundProgressScreen.resume(
                  launch: nextLaunch,
                ),
              ),
            ));
            return;
          }
        } else {
          await Navigator.of(context).push<void>(
            MaterialPageRoute<void>(
              builder: (_) => ResultScreen(
                mode: widget.session?.mode ?? _modeFromLaunch(launch),
                imageFile: output,
                frameCount: launch.frameCount,
                deleteTemporaryResultOnDispose: false,
              ),
            ),
          );
        }
        await StackJobRegistry.discardTerminalJob(
          uniqueName: launch.uniqueName,
          statusPath: launch.statusPath,
          outputPath: outputPath,
        );
        if ((launch.jobKind == 'focusMarking' ||
                launch.jobKind == 'meteorAnalysis') &&
            mounted) {
          Navigator.of(context).pop();
        }
      } on Object catch (error) {
        _openedResult = false;
        if (mounted) setState(() => _error = error);
      }
    } else if (status.state == StackJobState.interruptedRecoverable) {
      // Keep the screen interactive. The verified star-trail decode
      // checkpoints remain on disk and the processor can be restarted.
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

  Future<void> _resumeAfterPlatformTimeoutIfNeeded() async {
    if (!Platform.isAndroid || _autoResumingTimeout || _restartingProcessor) {
      await _poll();
      return;
    }
    _autoResumingTimeout = true;
    try {
      await ForegroundTimeoutRecovery.resumeIfNeeded();
    } on Object {
      // A denial here (including Android's transient FGS-start race at the
      // exact resume instant) must not turn an already-recoverable job into
      // an unretryable dead-end failure screen: setting _error would hide
      // the "保存済み地点から再開" button behind a bare error message with no
      // way back. The persisted interruptedRecoverable status stays
      // authoritative and visible instead, matching how the app-root and
      // CFA Drizzle progress screen already treat this same automatic
      // attempt. The next foreground/window-focus event or a manual tap on
      // the explicit resume button will retry.
    } finally {
      _autoResumingTimeout = false;
    }
    await _poll();
  }

  Future<void> _restartProcessor() async {
    final BackgroundStackLaunch? launch = _launch;
    // Guard against racing the automatic foreground-timeout resume attempt
    // (_resumeAfterPlatformTimeoutIfNeeded), which also calls into the same
    // native processor-launch path. The native side now coalesces concurrent
    // callers for the same job rather than dropping one, but disabling the
    // button here avoids firing a redundant second MethodChannel call at all.
    if (launch == null || _restartingProcessor || _autoResumingTimeout) return;
    setState(() => _restartingProcessor = true);
    try {
      await BackgroundStackController.restartProcessor(launch);
      if (!mounted) return;
      setState(() {
        _status = _status?.copyWith(stage: '処理システムを再起動中…');
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _restartingProcessor = false);
    }
  }

  Future<void> _retryOpeningCompletedResult() async {
    if (_openedResult) return;
    setState(() => _error = null);
    await _poll();
  }

  bool get _canCancel {
    final StackJobState? state = _status?.state;
    return _launch != null &&
        _error == null &&
        (state == null ||
            state == StackJobState.queued ||
            state == StackJobState.running);
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
    // The worker itself will reach StackJobState.cancelled once it notices
    // the request at its next safe point (see StackJobReporter's doc
    // comment) — this just reflects that a stop was requested immediately,
    // rather than leaving the screen looking unchanged while waiting.
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
        content: const Text(
          '保存済みチェックポイントと再開権を破棄し、新しい処理を開始できる状態にします。',
        ),
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

  Future<BackgroundStackLaunch?> _openFocusMarkingReview(
    BackgroundStackLaunch launch,
    String resultPath,
  ) async {
    final FocusMarkingBackgroundResult persisted =
        await readFocusMarkingBackgroundResult(resultPath);
    final List<RawInputFile> inputs = await _rebuildRawInputs(
      persisted.sourcePaths,
    );
    final FocusMarkingPreviewModel model = buildFocusMarkingPreviewModel(
      inputs: inputs,
      marking: persisted.analysis.marking,
      exactPreviews: persisted.analysis.exactPreviews,
      autoExclude: persisted.autoExcludeOmissionCandidates,
      referenceFrameIndex: persisted.referenceIndex,
      initialSelection: persisted.initialSelection,
      omissionCandidates: persisted.omissionCandidates,
    );
    FocusMarkingPreviewModel? confirmed;
    if (!mounted) return null;
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => FocusMarkingReviewScreen(
          initialModel: model,
          showOmissionCandidates: persisted.showOmissionCandidates,
          onConfirmed: (FocusMarkingPreviewModel value) {
            confirmed = value;
            Navigator.of(context).pop();
          },
        ),
      ),
    );
    final FocusMarkingPreviewModel? selected = confirmed;
    if (selected == null) return null;
    final String referencePath =
        persisted.sourcePaths[persisted.referenceIndex];
    final int selectedReferenceIndex = selected.selectedInputs.indexWhere(
      (RawInputFile input) => input.path == referencePath,
    );
    if (selectedReferenceIndex < 0) {
      throw StateError('基準写真は深度合成から除外できません。');
    }
    return BackgroundStackController.startFocusStack(
      inputs: selected.selectedInputs,
      referenceIndex: selectedReferenceIndex,
      outputFormatName: persisted.outputFormatName,
      storagePresetName: persisted.storagePresetName,
    );
  }

  Future<List<RawInputFile>> _rebuildRawInputs(List<String> paths) async {
    final metadataProbe = createProductionNativeRawMetadataProbe();
    final List<RawInputFile> inputs = <RawInputFile>[];
    for (final String path in paths) {
      final probe = await const RawFileProbe().probe(path);
      if (!probe.isAccepted) {
        throw StateError(probe.warning ?? 'RAW入力確認に失敗しました。');
      }
      final metadata = metadataProbe.supports(probe.format)
          ? await metadataProbe.probe(probe)
          : null;
      inputs.add(RawInputFile(
        path: path,
        byteLength: probe.byteLength,
        probe: probe,
        metadata: metadata,
      ));
    }
    return inputs;
  }

  Future<BackgroundStackLaunch?> _openMeteorReview(
    BackgroundStackLaunch launch,
    String analysisPath,
  ) async {
    final MeteorAnalysisResult result =
        await readMeteorAnalysisResult(analysisPath);
    bool handedToReview = false;
    BackgroundStackLaunch? finalLaunch;
    try {
      final DngFinalRenderProfile? renderProfile =
          await _loadMeteorReferenceProfile(launch.sourcePaths);
      final OutputImageFormat outputFormat = _outputFormatByName(
        launch.outputFormatName,
      );
      final LightroomStoragePreset storagePreset = _storagePresetByName(
        launch.storagePresetName,
      );
      if (!mounted) return null;
      handedToReview = true;
      await Navigator.of(context).push<void>(
        MaterialPageRoute<void>(
          builder: (_) => MeteorReviewScreen(
            result: result,
            outputFormat: outputFormat,
            storagePreset: storagePreset,
            renderProfile: renderProfile,
            onBackgroundCompositeRequested: (List<int> selectedIndices) async {
              finalLaunch =
                  await BackgroundStackController.startMeteorComposite(
                analysisLaunch: launch,
                selectedCandidateIndices: selectedIndices,
              );
            },
          ),
        ),
      );
    } finally {
      if (!handedToReview) {
        for (final store in result.frameStores) {
          try {
            await store?.dispose();
          } on Object {
            // Best-effort cleanup if review reconstruction fails.
          }
        }
      }
    }
    return finalLaunch;
  }

  Future<DngFinalRenderProfile?> _loadMeteorReferenceProfile(
    List<String> sourcePaths,
  ) async {
    if (sourcePaths.isEmpty) return null;
    final String path = sourcePaths.first;
    final probe = await const RawFileProbe().probe(path);
    if (!probe.isAccepted) return null;
    final metadataProbe = createProductionNativeRawMetadataProbe();
    if (!metadataProbe.supports(probe.format)) return null;
    final metadata = await metadataProbe.probe(probe);
    return DngFinalRenderProfile.fromMetadata(
      sourceId: path,
      metadata: metadata.metadata,
      cfaPattern: metadata.cfaPattern,
    );
  }

  OutputImageFormat _outputFormatByName(String name) {
    for (final OutputImageFormat value in OutputImageFormat.values) {
      if (value.name == name) return value;
    }
    return OutputImageFormat.linearDng;
  }

  LightroomStoragePreset _storagePresetByName(String name) {
    for (final LightroomStoragePreset value in LightroomStoragePreset.values) {
      if (value.name == name) return value;
    }
    return LightroomStoragePreset.maximum;
  }

  @override
  Widget build(BuildContext context) {
    final StackJobStatus? status = _status;
    final double progress = status?.progress ?? 0;
    final int percent = (progress.clamp(0.0, 1.0) * 100).round();
    final int elapsed = status?.elapsedSeconds ?? 0;
    final int updatedEpochMs = status?.updatedEpochMs ?? 0;
    final int age = updatedEpochMs <= 0
        ? 0
        : DateTime.now()
            .difference(DateTime.fromMillisecondsSinceEpoch(updatedEpochMs))
            .inSeconds
            .clamp(0, 1 << 31)
            .toInt();
    final BackgroundStackLaunch? launch = _launch;
    final int progressEpochMs = status?.progressEpochMs ?? 0;
    final int progressAge = progressEpochMs <= 0
        ? age
        : DateTime.now()
            .difference(DateTime.fromMillisecondsSinceEpoch(progressEpochMs))
            .inSeconds
            .clamp(0, 1 << 31)
            .toInt();
    final bool inFlight = status?.state == StackJobState.queued ||
        status?.state == StackJobState.running;
    final bool processorUnresponsive =
        inFlight && (age >= 15 || progressAge >= 30 * 60);
    final bool recoverableInterruption =
        status?.state == StackJobState.interruptedRecoverable;
    final String title =
        launch?.jobLabel ?? widget.session?.mode.label ?? 'バックグラウンド処理';
    return Scaffold(
      appBar: AppBar(
        title: Text(title),
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
            child: _error != null
                ? Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Text('処理結果を開けませんでした：$_error'),
                        if (_status?.state ==
                            StackJobState.completed) ...<Widget>[
                          const SizedBox(height: 12),
                          FilledButton.icon(
                            onPressed: _retryOpeningCompletedResult,
                            icon: const Icon(Icons.refresh),
                            label: const Text('結果をもう一度開く'),
                          ),
                        ],
                      ],
                    ),
                  )
                : ListView(
                    children: <Widget>[
                      const SizedBox(height: 28),
                      Text(status == null ? '準備中' : '$percent%',
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                              fontSize: 36, fontWeight: FontWeight.w800)),
                      const SizedBox(height: 12),
                      LinearProgressIndicator(
                        value: status == null ? null : progress,
                        minHeight: 9,
                      ),
                      const SizedBox(height: 24),
                      _Row(
                          '稼働状態',
                          processorUnresponsive
                              ? '処理システム応答待ち（UI正常）'
                              : _stateLabel(status?.state)),
                      _Row('現在工程', status?.stage ?? _startingStage),
                      _Row(
                          '処理枚数',
                          (status?.totalItems ?? 0) > 0
                              ? '${status!.currentItem} / ${status.totalItems}'
                              : '準備中'),
                      _Row(
                          '経過時間', StackJobNotifications.formatElapsed(elapsed)),
                      _Row('最終更新', updatedEpochMs <= 0 ? '待機中' : '$age秒前'),
                      _Row('稼働確認', '#${status?.heartbeat ?? 0}'),
                      if ((status?.recoveryAttempt ?? 0) > 0)
                        _Row(
                          '自動復旧',
                          '${status!.recoveryAttempt}/${status.recoveryMaxAttempts}回',
                        ),
                      if ((status?.lastProcessorExitReason ?? '').isNotEmpty)
                        _Row('過去のprocessor終了履歴',
                            status!.lastProcessorExitReason!),
                      if (recoverableInterruption) ...<Widget>[
                        const SizedBox(height: 12),
                        Card(
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: <Widget>[
                                Text(
                                  '処理は中断しましたが、正常確定済みの '
                                  '${status?.recoverableCheckpointItems ?? 0} 枚は保存されています。',
                                ),
                                if (status?.recoveryCause ==
                                    'foreground-service-timeout') ...<Widget>[
                                  const SizedBox(height: 8),
                                  const Text(
                                    '今回の停止原因はAndroidの長時間バックグラウンド処理制限です。'
                                    'CRASH表示がある場合も、それは過去のprocessor終了履歴で今回原因ではありません。',
                                  ),
                                ],
                                if ((status?.error ?? '')
                                    .isNotEmpty) ...<Widget>[
                                  const SizedBox(height: 8),
                                  Text(status!.error!),
                                ],
                                const SizedBox(height: 12),
                                FilledButton.icon(
                                  onPressed: (_restartingProcessor ||
                                          _autoResumingTimeout)
                                      ? null
                                      : _restartProcessor,
                                  icon: const Icon(Icons.play_arrow),
                                  label: Text(_restartingProcessor
                                      ? '再開中…'
                                      : '保存済み地点から再開'),
                                ),
                                const SizedBox(height: 8),
                                OutlinedButton.icon(
                                  onPressed: _confirmAbandonRecoverableJob,
                                  icon: const Icon(Icons.delete_outline),
                                  label: const Text('この処理を破棄'),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                      if (processorUnresponsive) ...<Widget>[
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
                                  onPressed: (_restartingProcessor ||
                                          _autoResumingTimeout)
                                      ? null
                                      : _restartProcessor,
                                  icon: const Icon(Icons.restart_alt),
                                  label: Text(_restartingProcessor
                                      ? '再起動中…'
                                      : '処理システムだけ再起動して続行'),
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
                            'AndroidではUIと画像処理を別OSプロセスに分離して実行します。'
                            '画像処理側が停止・ANRになってもUI側は独立して監視・操作できます。'
                            '別アプリへ切り替えた場合や画面をOFFにした場合も処理は継続します。\n\n'
                            '完了時は通知します。残り時間は表示せず、進捗率・工程・処理枚数・経過時間・最終更新で稼働状態を表示します。'
                            '右上のボタンでいつでも中止できます。',
                            style: TextStyle(
                                color: MobileStackColors.muted, height: 1.5),
                          ),
                        ),
                      ),
                    ],
                  ),
          ),
        ),
      ),
    );
  }

  String _stateLabel(StackJobState? state) => switch (state) {
        StackJobState.queued => '待機中',
        StackJobState.running => '処理中',
        StackJobState.completed => '完了',
        StackJobState.failed => 'エラー',
        StackJobState.interruptedRecoverable => '中断・再開可能',
        StackJobState.cancelled => '停止',
        null => '起動中',
      };
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.value);
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: <Widget>[
            SizedBox(
                width: 92,
                child: Text(label,
                    style: const TextStyle(color: MobileStackColors.muted))),
            Expanded(child: Text(value)),
          ],
        ),
      );
}
