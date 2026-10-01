import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/diagnostics/processing_failure_report.dart';
import '../../core/background/stack_job_notifications.dart';
import '../../core/engine/concurrency_policy.dart';
import '../../core/engine/default_resource_reader.dart';
import '../../core/engine/job_scheduler.dart';
import '../../core/engine/phase2_validated_job_executor.dart';
import '../../core/engine/prepare_master_calibration_frame.dart';
import '../../core/engine/processing_job.dart';
import '../../core/export/output_image_format.dart';
import '../../core/export/dng_final_render_profile.dart';
import '../../core/export/reference_render_profile_selection.dart';
import '../../core/image/file_backed_linear_rgb_tile_store.dart';
import '../../core/image/downscale_linear_rgb_store.dart';
import '../../core/image/linear_raw_mosaic.dart';
import '../../core/image/raw_saturation_mask.dart';
import '../../core/image/linear_rgb_tile_store.dart';
import '../../core/io/raw_input_contract.dart';
import '../../core/models/processing_mode.dart';
import '../../core/raw/native_raw_decoder_factory.dart';
import '../../core/raw/raw_decoder_registry.dart';
import '../../core/raw/raw_metadata_probe.dart';
import '../../core/session/export_pipeline_result.dart';
import '../../core/session/meteor_pipeline.dart';
import '../../core/session/processing_session.dart';
import '../../design/mobile_stack_theme.dart';
import '../meteor/meteor_review_screen.dart';
import 'result_screen.dart';
import 'processing_failure_panel.dart';

/// Ceiling for a single frame's RAW validation/decode job
/// (`runPhase2ValidatedJob`). Chosen generously above the slowest
/// legitimate case observed in testing (full-sensor lossless-compressed
/// ARW/NEF, full-quality demosaic, on modest hardware) so it never fires
/// during genuine — if slow — work. It exists purely to convert an
/// indefinite freeze into a visible failure; see the `jobTimeout` comment
/// at the `JobScheduler` construction site below.
const Duration perFrameProcessingTimeout = fullFrameRawStallTimeout;

class ProcessingProgressScreen extends StatefulWidget {
  const ProcessingProgressScreen({
    required this.session,
    this.darkFramePaths,
    this.flatFramePaths,
    this.initialFailureReport,
    this.initialSnapshot,
    super.key,
  });

  final ProcessingSession session;

  /// RAWダーク/フラットフレームのファイルパス(Work111)。`null`
  /// (既定値、既存の呼び出し元は全てこれを渡していない)の場合は
  /// ダーク/フラット較正・ホットピクセル検出(Work96-109)を一切
  /// 適用しない — 挙動は一切変わらない。
  final List<String>? darkFramePaths;
  final List<String>? flatFramePaths;

  /// Deterministic downstream-failure injection used by widget regression
  /// tests. Production callers leave both values null.
  final ProcessingFailureReport? initialFailureReport;
  final JobSchedulerSnapshot? initialSnapshot;

  @override
  State<ProcessingProgressScreen> createState() =>
      _ProcessingProgressScreenState();
}

class _ProcessingProgressScreenState extends State<ProcessingProgressScreen> {
  JobScheduler? _scheduler;
  late final RawMetadataProbe? _metadataProbe;
  late final RawDecoderRegistry _decoderRegistry;
  StreamSubscription<JobSchedulerSnapshot>? _subscription;
  JobSchedulerSnapshot _snapshot = const JobSchedulerSnapshot(
    queuedCount: 0,
    activeCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    overallProgress: 0,
  );
  bool _finishing = false;

  /// 検証フェーズ(runPhase2ValidatedJob)で各フレームがコミットした
  /// タイルストアを、破棄させずにここで保持しておく(onTileStoreReady,
  /// Work53)。こうすることで、後続のスタッキング/分析フェーズが
  /// 同じソースをもう一度デコードし直す必要がなくなる — Work65/66では
  /// 「二重デコードを安全側の設計判断として受け入れる」としていたが、
  /// 実際にはこのフックを使うだけで二重デコードを避けられることに
  /// Work67で気づき、置き換えた。フレームストアの所有権は、検証成功後
  /// はこの画面(スタッキング/分析フェーズで使い、その後破棄するか
  /// meteor_review_screen.dartへ引き継ぐ)にある。
  late final List<LinearRgbTileStore?> _frameStores;
  late final List<RawSaturationMask?> _saturationInfluenceMasks;
  late final List<DngFinalRenderProfile?> _renderProfiles;

  /// Whether the second phase — actually stacking the validated frames
  /// and exporting a viewable image (star trail/Milky Way mode, Work65),
  /// or analyzing them for streak candidates and opening the review
  /// screen (meteor mode, Work66) — is currently running.
  bool _stacking = false;
  bool _cancellationRequested = false;
  ProcessingFailureStage _currentStage =
      ProcessingFailureStage.rawInputValidation;
  String? _currentSubstage;
  ProcessingFailureStage? _lastCompletedStage;

  bool get _shouldCancel => _cancellationRequested || !mounted;

  List<ProcessingJob> get _failedJobs {
    final JobScheduler? scheduler = _scheduler;
    if (scheduler == null) return const <ProcessingJob>[];
    return <ProcessingJob>[
      for (final ProcessingJob job in scheduler.jobs)
        if (job.state == ProcessingJobState.failed) job,
    ];
  }

  String _failureStage(ProcessingJob job) =>
      job.currentStageLabel ?? 'RAWファイル検証／ネイティブデコード';

  String _failureMessage(ProcessingJob job) {
    final Object? error = job.error;
    if (error == null) return '詳細エラーが記録されていません。';
    return error.toString();
  }

  void _beginStage(ProcessingFailureStage stage, [String? substage]) {
    _currentStage = stage;
    _currentSubstage = substage;
  }

  void _completeStage(ProcessingFailureStage stage) {
    _lastCompletedStage = stage;
  }

  ProcessingFailureReport _captureFailure(
    Object error,
    StackTrace stackTrace, {
    RawInputFile? target,
    ProcessingFailureStage? stage,
    ProcessingFailureStage? lastCompletedStage,
    String? substage,
  }) {
    final int? referenceIndex = widget.session.referenceIndex;
    final RawInputFile? reference =
        referenceIndex == null ? null : widget.session.files[referenceIndex];
    return ProcessingFailureReport.capture(
      error: error,
      stackTrace: stackTrace,
      mode: widget.session.mode,
      stage: stage ?? _currentStage,
      substage: substage ?? _currentSubstage,
      inputs: widget.session.files,
      target: target,
      reference: reference,
      referenceIndex: referenceIndex,
      outputFormat: widget.session.outputFormat,
      completedJobs: _snapshot.completedCount,
      failedJobs: _snapshot.failedCount,
      cancelled: _cancellationRequested || _snapshot.cancelledCount > 0,
      lastCompletedStage: lastCompletedStage ?? _lastCompletedStage,
    );
  }

  @override
  void initState() {
    super.initState();
    widget.session.markProcessing();
    unawaited(StackJobNotifications.requestPermission());
    _metadataProbe = createProductionNativeRawMetadataProbe();
    _decoderRegistry = createProductionNativeRawDecoderRegistry();
    _frameStores = List<LinearRgbTileStore?>.filled(
      widget.session.files.length,
      null,
    );
    _saturationInfluenceMasks = List<RawSaturationMask?>.filled(
      widget.session.files.length,
      null,
    );
    _renderProfiles = List<DngFinalRenderProfile?>.filled(
      widget.session.files.length,
      null,
    );
    final ProcessingFailureReport? initialFailure = widget.initialFailureReport;
    if (initialFailure != null) {
      _snapshot = widget.initialSnapshot ??
          JobSchedulerSnapshot(
            queuedCount: 0,
            activeCount: 0,
            completedCount: initialFailure.completedJobs,
            failedCount: initialFailure.failedJobs,
            cancelledCount: initialFailure.cancelled ? 1 : 0,
            overallProgress: 1,
          );
      widget.session.markFailed(
        StateError(initialFailure.message),
        stackTrace: StackTrace.fromString(initialFailure.stackTrace),
        report: initialFailure,
      );
      _finishing = true;
      return;
    }
    unawaited(_resolveCalibrationFramesAndStart());
  }

  /// ダーク/フラットフレームのファイルパス(Work111、
  /// `widget.darkFramePaths`/`widget.flatFramePaths`)が指定されて
  /// いれば、`prepareMasterDark`/`prepareMasterFlat`(Work104)で
  /// マスターフレームへ解決してから、通常通りスケジューラを起動する。
  /// どちらも`null`(既存の呼び出し元は全てこの状態)の場合、この解決
  /// ステップは実質的に何もせず即座に完了するため、既存の挙動には
  /// 一切影響しない。
  Future<void> _resolveCalibrationFramesAndStart() async {
    LinearRawMosaic? masterDark;
    LinearRawMosaic? masterFlat;
    try {
      if (widget.darkFramePaths != null && widget.darkFramePaths!.isNotEmpty) {
        masterDark = await prepareMasterDark(
          sourcePaths: widget.darkFramePaths!,
          decoderRegistry: _decoderRegistry,
        );
      }
      if (widget.flatFramePaths != null && widget.flatFramePaths!.isNotEmpty) {
        masterFlat = await prepareMasterFlat(
          sourcePaths: widget.flatFramePaths!,
          decoderRegistry: _decoderRegistry,
          darkToSubtract: masterDark,
        );
      }
    } catch (error, stackTrace) {
      if (!mounted) return;
      widget.session.markFailed(
        error,
        stackTrace: stackTrace,
        report: _captureFailure(
          error,
          stackTrace,
          substage: 'ダーク／フラット較正フレーム準備',
        ),
      );
      setState(() {});
      return;
    }
    if (!mounted) return;
    if (_cancellationRequested) {
      // 較正フレーム解決中にキャンセルされた場合、_startScheduler自体を
      // 呼ばないため _onSnapshot(通常はスケジューラ完了時にセッション
      // 状態を更新する)が一度も発火しない。ここで明示的にキャンセル
      // 状態へ遷移させないと、画面が「処理中」のまま止まってしまう。
      widget.session.markCancelled();
      setState(() {});
      return;
    }
    _startScheduler(masterDark: masterDark, masterFlat: masterFlat);
  }

  void _startScheduler({
    required LinearRawMosaic? masterDark,
    required LinearRawMosaic? masterFlat,
  }) {
    final JobScheduler scheduler = JobScheduler(
      executor: (ProcessingJob job, void Function(double) reportProgress) {
        final int frameIndex = int.parse(job.id.split('-').last);
        return runPhase2ValidatedJob(
          job,
          reportProgress,
          metadataProbe: _metadataProbe,
          decoderRegistry: _decoderRegistry,
          masterDark: masterDark,
          masterFlat: masterFlat,
          fileBackRawBeforeDemosaic: true,
          preferStreamedRawCalibration: true,
          onRenderMetadataReady: (metadata, cfaPattern) {
            _renderProfiles[frameIndex] = DngFinalRenderProfile.fromMetadata(
              sourceId: job.sourcePath,
              metadata: metadata,
              cfaPattern: cfaPattern,
            );
          },
          onTileStoreReady: (LinearRgbTileStore tileStore) {
            _frameStores[frameIndex] = tileStore;
          },
          onSaturationMaskReady: (RawSaturationMask? mask) {
            _saturationInfluenceMasks[frameIndex] = mask;
          },
        );
      },
      resourceReader: readDefaultResourceSnapshot,
      policy: fullFrameRawConcurrencyPolicy,
      // Full-frame RAW decode/validation runs one file at a time (see
      // fullFrameRawConcurrencyPolicy) and, on real devices, can stall
      // indefinitely under memory/thermal/storage pressure that this
      // screen has no other way to detect. Without a ceiling, a single
      // stuck job leaves activeCount at 1 forever: JobSchedulerSnapshot
      // .isFinished never becomes true, so the screen can never advance
      // to stacking/export even though the progress percentage may
      // already be rounding to 100%. This does not lower output quality
      // — it only turns an infinite freeze into a clear, actionable
      // failure so the user can retry instead of force-closing the app.
      jobTimeout: perFrameProcessingTimeout,
    );
    _scheduler = scheduler;
    _subscription = scheduler.snapshots.listen(_onSnapshot);

    final List<ProcessingJob> jobs = <ProcessingJob>[
      for (int index = 0; index < widget.session.files.length; index++)
        ProcessingJob(
          id: '${DateTime.now().microsecondsSinceEpoch}-$index',
          mode: widget.session.mode,
          sourcePath: widget.session.files[index].path,
        ),
    ];
    scheduler.enqueueAll(jobs);
  }

  /// 使われないまま残っているタイルストア(検証失敗・キャンセル時、あ
  /// るいはこの画面自体が破棄される時)をまとめて破棄する。
  /// FileBackedLinearRgbTileStore.dispose は冪等なので、既に破棄済み
  /// のものが混ざっていても安全(Work66で確認済みの性質を再利用)。
  void _disposeUnusedFrameStores() {
    for (final LinearRgbTileStore? store in _frameStores) {
      if (store != null) unawaited(store.dispose());
    }
  }

  void _onSnapshot(JobSchedulerSnapshot snapshot) {
    if (!mounted) return;
    setState(() => _snapshot = snapshot);
    widget.session.updateProgress(snapshot.overallProgress);

    final int terminalJobCount = snapshot.completedCount +
        snapshot.failedCount +
        snapshot.cancelledCount;
    final bool allInputJobsTerminal =
        terminalJobCount == widget.session.files.length;

    // `isFinished` describes the scheduler queue/active bookkeeping, but the
    // UI must not enter stacking/export until every input job has reached a
    // terminal state. Keeping this independent terminal-count gate prevents
    // any transient scheduler snapshot from starting downstream work while a
    // RAW frame is still committing its tile store/render profile.
    if (snapshot.isFinished && allInputJobsTerminal && !_finishing) {
      _finishing = true;
      if (snapshot.failedCount > 0) {
        _disposeUnusedFrameStores();
        final List<ProcessingJob> failed = _failedJobs;
        final String detail = failed.isEmpty
            ? '${snapshot.failedCount}件のジョブが失敗しました。'
            : '${snapshot.failedCount}件のジョブが失敗しました。'
                ' 最初の失敗: ${failed.first.sourcePath} / '
                '${_failureStage(failed.first)} / '
                '${_failureMessage(failed.first)}';
        final ProcessingJob? firstFailed = failed.isEmpty ? null : failed.first;
        final Object error = firstFailed?.error ?? StateError(detail);
        final StackTrace stackTrace =
            firstFailed?.errorStackTrace ?? StackTrace.current;
        final ProcessingFailureStage stage =
            ProcessingFailureStage.fromJobLabel(firstFailed?.currentStageLabel);
        widget.session.markFailed(
          error,
          stackTrace: stackTrace,
          report: _captureFailure(
            error,
            stackTrace,
            target: firstFailed == null
                ? null
                : widget.session.files.firstWhere(
                    (RawInputFile file) => file.path == firstFailed.sourcePath,
                  ),
            stage: stage,
            substage: firstFailed?.currentStageLabel,
            lastCompletedStage: ProcessingFailureStage.fromJobLabel(
              firstFailed?.lastCompletedStageLabel,
            ),
          ),
        );
        setState(() {});
      } else if (snapshot.cancelledCount > 0) {
        _disposeUnusedFrameStores();
        widget.session.markCancelled();
        setState(() {});
      } else if (widget.session.mode == ProcessingMode.starTrail ||
          widget.session.mode == ProcessingMode.milkyWay) {
        // 検証が全件成功したので、実際のスタッキング処理へ進む。
        unawaited(_runStackingAndShowResult());
      } else {
        // 流星モード: 検証が全件成功したので、流星痕候補の分析へ進む。
        unawaited(_runMeteorAnalysisAndShowReview());
      }
    }
  }

  /// 検証フェーズが既にコミット済みの [_frameStores] を使って、実際の
  /// スタッキングパイプライン(star_trail_pipeline.dart /
  /// milky_way_pipeline.dart, Work53/54)を実行し、結果をBMPとして
  /// 書き出して(export_pipeline_result.dart, Work58)、結果画面へ
  /// 遷移する。
  ///
  /// 検証フェーズと同じフレームをもう一度デコードすることはしない
  /// (Work67: onTileStoreReadyで保持しておいたストアをそのまま使う)。
  Future<void> _runStackingAndShowResult() async {
    setState(() => _stacking = true);
    final List<String> sourcePaths = <String>[
      for (final file in widget.session.files) file.path,
    ];
    Directory? outputDirectory;
    bool resultHandedToScreen = false;
    try {
      final int? selectedReferenceIndex = widget.session.referenceIndex;
      if (selectedReferenceIndex == null) {
        _beginStage(
          ProcessingFailureStage.referenceFramePreparation,
          '選択基準RAWのindex解決',
        );
        throw StateError('選択した基準写真が入力RAWに見つかりません。');
      }
      final OutputImageFormat outputFormat = widget.session.outputFormat;
      _beginStage(
        ProcessingFailureStage.finalRenderProfileValidation,
        '選択基準RAWのWB／色／DNGメタデータ整合性検証',
      );
      final DngFinalRenderProfile renderProfile =
          requireAlignedReferenceRenderProfile(
        profiles: _renderProfiles,
        sourcePaths: sourcePaths,
        referenceIndex: selectedReferenceIndex,
      );
      _completeStage(ProcessingFailureStage.finalRenderProfileValidation);
      _beginStage(
        ProcessingFailureStage.outputFilePreparation,
        '出力先一時ディレクトリ作成',
      );
      outputDirectory = await Directory.systemTemp.createTemp(
        'mobile-stack-result-',
      );
      _completeStage(ProcessingFailureStage.outputFilePreparation);
      final String outputPath = '${outputDirectory.path}'
          '${Platform.pathSeparator}result.${outputFormat.extension}';
      final File resultFile;
      void reportStage(ProcessingFailureStage stage, String? substage) {
        _beginStage(stage, substage);
      }

      final quality = widget.session.qualityLevel;
      final LinearRgbTileStore firstStore = _frameStores.first!;
      final int outputWidth = quality.scaledDimension(firstStore.width);
      final int outputHeight = quality.scaledDimension(firstStore.height);
      final int outputPixels = outputWidth * outputHeight;
      final int exportBytesPerPixel = switch (outputFormat) {
        OutputImageFormat.linearDng =>
          widget.session.storagePreset.usesCompressionStaging ? 24 : 12,
        OutputImageFormat.tiff16 => 6,
        OutputImageFormat.jpeg || OutputImageFormat.bmp8 => 4,
      };
      final int downscalePeak = quality.linearScale < 1 ? outputPixels * 12 : 0;
      final int requiredWorkingBytes =
          outputPixels * (12 + 6 + exportBytesPerPixel) +
              downscalePeak +
              256 * 1024 * 1024;
      final resources = await readDefaultResourceSnapshot();
      final int? availableStorage = resources.availableStorageBytes;
      if (availableStorage != null && availableStorage < requiredWorkingBytes) {
        final int requiredMiB = (requiredWorkingBytes / (1024 * 1024)).ceil();
        final int availableMiB = (availableStorage / (1024 * 1024)).floor();
        throw StateError(
          '一時ストレージが不足しています。選択設定では約${requiredMiB}MB必要ですが、'
          '使用可能なのは約${availableMiB}MBです。画質または保存容量を下げてください。',
        );
      }
      if (quality.linearScale < 1) {
        _beginStage(ProcessingFailureStage.stackCombination, '選択画質への事前縮小');
        for (int index = 0; index < _frameStores.length; index++) {
          final LinearRgbTileStore source = _frameStores[index]!;
          final LinearRgbTileStore scaled = await downscaleLinearRgbStore(
            source: source,
            linearScale: quality.linearScale,
            outputStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
            isCancelled: () => _shouldCancel,
          );
          _frameStores[index] = scaled;
          _saturationInfluenceMasks[index] = null;
          await source.dispose();
        }
      }

      if (widget.session.mode == ProcessingMode.starTrail) {
        resultFile = await combineDecodedFramesAndExport(
          frameStores: _frameStores.cast<LinearRgbTileStore>(),
          outputTileStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
          exportPath: outputPath,
          sourcePaths: sourcePaths,
          enableAircraftSatelliteRemoval:
              widget.session.automaticStarTrailAircraftRemoval,
          referenceForegroundStore: _frameStores[selectedReferenceIndex]!,
          foregroundRegion: widget.session.foregroundRegion,
          preserveReferenceForeground:
              widget.session.automaticStarTrailForegroundProtection,
          outputFormat: outputFormat,
          linearDngCompression: widget.session.storagePreset.dngCompression,
          tileSize: quality.processingTileSize,
          renderProfile: renderProfile,
          reportStage: reportStage,
          isCancelled: () => _shouldCancel,
        );
      } else {
        resultFile = await registerAndCombineDecodedFramesAndExport(
          sourcePaths: sourcePaths,
          frameStores: _frameStores,
          saturationInfluenceMasks: _saturationInfluenceMasks,
          decodeFailures: const <int, Object?>{},
          outputTileStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
          exportPath: outputPath,
          outputFormat: outputFormat,
          linearDngCompression: widget.session.storagePreset.dngCompression,
          maximumIterations: quality.maximumIterations,
          tileSize: quality.processingTileSize,
          enableLocalRegistration: quality.enableLocalRegistration,
          interpolation: quality.interpolation,
          preserveStaticForeground: quality.preserveStaticForeground,
          enableMovingObjectRemoval:
              widget.session.automaticMovingObjectRemoval,
          renderProfile: renderProfile,
          referenceIndex: selectedReferenceIndex,
          reportStage: reportStage,
          isCancelled: () => _shouldCancel,
        );
      }
      if (_shouldCancel) {
        if (await resultFile.exists()) await resultFile.delete();
        if (mounted) widget.session.markCancelled();
        return;
      }
      if (!mounted) return;
      widget.session.markCompleted();
      _beginStage(ProcessingFailureStage.resultHandoff, '結果画面を開く');
      await Navigator.of(context).push<void>(
        MaterialPageRoute<void>(
          builder: (_) => ResultScreen(
            mode: widget.session.mode,
            imageFile: resultFile,
            frameCount: sourcePaths.length,
          ),
        ),
      );
      // Mark the handoff only after Navigator.push itself succeeds. Setting
      // this before push leaked the owned result directory if route creation
      // or navigation threw before ResultScreen could take ownership.
      resultHandedToScreen = true;
      _completeStage(ProcessingFailureStage.resultHandoff);
    } catch (error, stackTrace) {
      if (!mounted) return;
      if (_cancellationRequested) {
        widget.session.markCancelled();
      } else {
        widget.session.markFailed(
          error,
          stackTrace: stackTrace,
          report: _captureFailure(error, stackTrace),
        );
      }
    } finally {
      if (!resultHandedToScreen && outputDirectory != null) {
        try {
          if (await outputDirectory.exists()) {
            await outputDirectory.delete(recursive: true);
          }
        } on FileSystemException {
          // Best-effort cleanup; the pipeline's partial BMP is already
          // removed by export_result.dart.
        }
      }
      // combineDecodedFramesAndExport/registerAndCombineDecodedFramesAndExport
      // はどちらも入力フレームストア自体は破棄しない設計(呼び出し元が
      // 所有権を持つ、というWork53/54の設計どおり)なので、ここで
      // 明示的に破棄する。
      _disposeUnusedFrameStores();
      if (mounted) setState(() => _stacking = false);
    }
  }

  /// 検証フェーズが既にコミット済みの [_frameStores] を使って、流星痕
  /// 候補の分析(meteor_pipeline.dart, Work60)を実行し、結果をレビュー
  /// 画面(meteor_review_screen.dart, Work66)へ渡す。
  ///
  /// 検証フェーズと同じフレームをもう一度デコードすることはしない
  /// (Work67)。レビュー画面が [MeteorAnalysisResult.frameStores] の
  /// 所有権を引き継ぐため、ここでは破棄しない(その画面自身のdisposeで
  /// 破棄される -- meteor_review_screen.dart自身のドキュメント参照)。
  Future<void> _runMeteorAnalysisAndShowReview() async {
    setState(() => _stacking = true);
    final List<String> sourcePaths = <String>[
      for (final file in widget.session.files) file.path,
    ];
    try {
      final MeteorAnalysisResult result = await analyzeDecodedFrames(
        sourcePaths: sourcePaths,
        frameStores: _frameStores,
        decodeFailures: const <int, Object?>{},
        isCancelled: () => _shouldCancel,
      );
      if (_shouldCancel) {
        _disposeUnusedFrameStores();
        if (mounted) widget.session.markCancelled();
        return;
      }
      if (!mounted) return;
      widget.session.markCompleted();
      try {
        await StackJobNotifications.showTaskCompleted(
          jobLabel: '流星群',
          message: '流星候補の解析が完了しました。候補を確認してください。',
        );
      } on Object {
        // Notification permission/failure must not affect image analysis.
      }
      if (!mounted) return;
      await Navigator.of(context).push<void>(
        MaterialPageRoute<void>(
          builder: (_) => MeteorReviewScreen(
            result: result,
            outputFormat: widget.session.outputFormat,
            storagePreset: widget.session.storagePreset,
            renderProfile: requireAlignedReferenceRenderProfile(
              profiles: _renderProfiles,
              sourcePaths: sourcePaths,
              referenceIndex: 0,
            ),
          ),
        ),
      );
    } catch (error, stackTrace) {
      if (!mounted) return;
      _disposeUnusedFrameStores();
      if (_cancellationRequested) {
        widget.session.markCancelled();
      } else {
        widget.session.markFailed(
          error,
          stackTrace: stackTrace,
          report: _captureFailure(
            error,
            stackTrace,
            stage: ProcessingFailureStage.stackCombination,
            substage: '流星候補解析／レビュー準備',
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _stacking = false);
    }
  }

  Future<void> _cancel() async {
    if (_cancellationRequested) return;
    setState(() => _cancellationRequested = true);
    // 較正フレーム解決中(_scheduler未起動)にキャンセルされた場合は、
    // _resolveCalibrationFramesAndStart 側の mounted チェックが
    // スケジューラの起動自体を抑止するため、ここでは既に起動済みの
    // 場合だけキャンセルすればよい。
    final JobScheduler? scheduler = _scheduler;
    if (scheduler == null) return;
    scheduler.cancelAll();
    await scheduler.waitUntilIdle();
  }

  @override
  void dispose() {
    _cancellationRequested = true;
    unawaited(_subscription?.cancel());
    final JobScheduler? scheduler = _scheduler;
    if (scheduler != null) unawaited(scheduler.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bool done = widget.session.status != SessionStatus.processing;
    // Cap the displayed percentage below 100% until every input job has
    // actually reached a terminal state. `overallProgress` is a plain
    // average of each job's self-reported progress, which can round to
    // 100% while the last job is still genuinely running (e.g. it reported
    // 0.99 and then stalled) — previously that showed "100%" next to a
    // spinner with no way to tell the two apart from a real freeze.
    final bool allJobsTerminal = _snapshot.activeCount == 0 &&
        _snapshot.queuedCount == 0 &&
        (_snapshot.completedCount +
                _snapshot.failedCount +
                _snapshot.cancelledCount) >=
            widget.session.files.length;
    final int rawPercent = (_snapshot.overallProgress * 100).round();
    final int percent = allJobsTerminal ? rawPercent : rawPercent.clamp(0, 99);
    final String progressLabel = _stacking
        ? (_cancellationRequested
            ? 'キャンセルしています…'
            : widget.session.mode == ProcessingMode.meteor
                ? '流星痕を分析中…'
                : 'スタッキング処理中…')
        : '$percent%';

    return PopScope(
      canPop: done,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (!didPop && !done) _showRunningNotice();
      },
      child: Scaffold(
        appBar: AppBar(title: const Text('処理状況')),
        body: StarfieldBackground(
          child: SafeArea(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 28),
              children: <Widget>[
                Align(
                  child: Container(
                    width: 86,
                    height: 86,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: (done
                              ? MobileStackColors.success
                              : MobileStackColors.accent)
                          .withValues(alpha: 0.12),
                      border: Border.all(
                        color: done
                            ? MobileStackColors.success
                            : MobileStackColors.accent,
                      ),
                    ),
                    child: Icon(
                      done ? _resultIcon : Icons.sync_rounded,
                      color: done
                          ? MobileStackColors.success
                          : MobileStackColors.accent,
                      size: 48,
                    ),
                  ),
                ),
                const SizedBox(height: 18),
                Text(
                  done ? _resultTitle : progressLabel,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 30,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  widget.session.mode.label,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: MobileStackColors.muted),
                ),
                const SizedBox(height: 22),
                ClipRRect(
                  borderRadius: BorderRadius.circular(999),
                  child: LinearProgressIndicator(
                    minHeight: 10,
                    value: _stacking ? null : _snapshot.overallProgress,
                  ),
                ),
                const SizedBox(height: 22),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: widget.session.status == SessionStatus.failed &&
                            widget.session.failureReport != null
                        ? _failedJobs.isNotEmpty
                            ? _FailedStageSummary(
                                stage: _failureStage(_failedJobs.first),
                              )
                            : _FailedStageSummary(
                                stage:
                                    widget.session.failureReport!.stage.label,
                              )
                        : Column(
                            children: <Widget>[
                              _StageRow(
                                label: '入力ファイルを確認',
                                progress: _snapshot.overallProgress,
                                threshold: 0,
                              ),
                              _StageRow(
                                label: 'RAW処理パイプラインを準備',
                                progress: _snapshot.overallProgress,
                                threshold: 0.2,
                              ),
                              _StageRow(
                                label: 'フレームを処理',
                                progress: _snapshot.overallProgress,
                                threshold: 0.4,
                              ),
                              _StageRow(
                                label: '一時データを解放',
                                progress: _snapshot.overallProgress,
                                threshold: 0.8,
                                isLast: true,
                              ),
                            ],
                          ),
                  ),
                ),
                const SizedBox(height: 12),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Row(
                      children: <Widget>[
                        _CountMetric(
                          label: '実行中',
                          value: _snapshot.activeCount,
                        ),
                        _CountMetric(label: '待機', value: _snapshot.queuedCount),
                        _CountMetric(
                          label: '完了',
                          value: _snapshot.completedCount,
                        ),
                        if (_snapshot.failedCount > 0)
                          _CountMetric(
                            label: '失敗',
                            value: _snapshot.failedCount,
                          ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 14),
                if (widget.session.status == SessionStatus.failed &&
                    widget.session.failureReport != null) ...<Widget>[
                  ProcessingFailurePanel(report: widget.session.failureReport!),
                  const SizedBox(height: 14),
                ],
                if (widget.session.status == SessionStatus.failed &&
                    _failedJobs.isNotEmpty) ...<Widget>[
                  _FailureDetailsCard(
                    failedJobs: _failedJobs,
                    stageFor: _failureStage,
                    messageFor: _failureMessage,
                  ),
                  const SizedBox(height: 14),
                ],
                const DecoratedBox(
                  decoration: BoxDecoration(
                    color: Color(0xFF2D2514),
                    borderRadius: BorderRadius.all(Radius.circular(10)),
                    border: Border.fromBorderSide(
                      BorderSide(color: Color(0xFF665227)),
                    ),
                  ),
                  child: Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                      '対応Sony ARW／Nikon NEF・NRWはフルセンサー読込と'
                      '黒／白レベル・カメラWB補正まで'
                      '実行します。独自の本番品質デモザイクはRGBをタイル保存し、'
                      '未接続時は低品質方式へ切り替えず開始時に停止します。',
                      style: TextStyle(
                        color: Color(0xFFFFD98A),
                        fontSize: 11,
                        height: 1.5,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 24),
                if (!done)
                  OutlinedButton.icon(
                    onPressed: _cancellationRequested ? null : _cancel,
                    icon: const Icon(Icons.stop_circle_outlined),
                    label: Text(
                      _cancellationRequested ? 'キャンセルしています…' : '処理をキャンセル',
                    ),
                  )
                else
                  FilledButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('RAW選択へ戻る'),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  IconData get _resultIcon => switch (widget.session.status) {
        SessionStatus.completed => Icons.check_circle_outline,
        SessionStatus.cancelled => Icons.cancel_outlined,
        SessionStatus.failed => Icons.error_outline,
        _ => Icons.info_outline,
      };

  String get _resultTitle => switch (widget.session.status) {
        SessionStatus.completed => 'RAW処理検証完了',
        SessionStatus.cancelled => 'キャンセルしました',
        SessionStatus.failed => '処理に失敗しました',
        _ => '処理終了',
      };

  void _showRunningNotice() {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('処理中です。終了する場合はキャンセルしてください。')));
  }
}

class _FailedStageSummary extends StatelessWidget {
  const _FailedStageSummary({required this.stage});

  final String stage;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Container(
          width: 28,
          height: 28,
          alignment: Alignment.center,
          decoration: const BoxDecoration(
            shape: BoxShape.circle,
            color: Color(0xFF7A2B2B),
          ),
          child: const Icon(
            Icons.close_rounded,
            size: 17,
            color: Color(0xFFFFD7D7),
          ),
        ),
        const SizedBox(width: 11),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Text('処理停止', style: TextStyle(fontWeight: FontWeight.w800)),
              const SizedBox(height: 2),
              Text(
                stage,
                style: const TextStyle(
                  color: MobileStackColors.warning,
                  fontSize: 11,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _StageRow extends StatelessWidget {
  const _StageRow({
    required this.label,
    required this.progress,
    required this.threshold,
    this.isLast = false,
  });

  final String label;
  final double progress;
  final double threshold;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    final bool complete = progress >= threshold + 0.2 || progress >= 1;
    final bool active = !complete && progress >= threshold;

    return Padding(
      padding: EdgeInsets.only(bottom: isLast ? 0 : 14),
      child: Row(
        children: <Widget>[
          Container(
            width: 28,
            height: 28,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: complete
                  ? const Color(0xFF246945)
                  : active
                      ? MobileStackColors.accent
                      : const Color(0xFF29313F),
            ),
            child: Icon(
              complete
                  ? Icons.check_rounded
                  : active
                      ? Icons.more_horiz_rounded
                      : Icons.circle_outlined,
              size: 17,
              color: complete
                  ? const Color(0xFFD8FFEA)
                  : active
                      ? Colors.white
                      : const Color(0xFF8690A3),
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                color:
                    active || complete ? Colors.white : MobileStackColors.muted,
                fontWeight: active ? FontWeight.w700 : FontWeight.w400,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _FailureDetailsCard extends StatelessWidget {
  const _FailureDetailsCard({
    required this.failedJobs,
    required this.stageFor,
    required this.messageFor,
  });

  final List<ProcessingJob> failedJobs;
  final String Function(ProcessingJob job) stageFor;
  final String Function(ProcessingJob job) messageFor;

  @override
  Widget build(BuildContext context) {
    final int shown = failedJobs.length > 5 ? 5 : failedJobs.length;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Row(
              children: <Widget>[
                Icon(Icons.error_outline_rounded, color: Color(0xFFFFA6A6)),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '失敗内容',
                    style: TextStyle(fontWeight: FontWeight.w800),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            for (int i = 0; i < shown; i++) ...<Widget>[
              Text(
                '${i + 1}. ${failedJobs[i].sourcePath.split(Platform.pathSeparator).last}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: 12,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                '工程: ${stageFor(failedJobs[i])}',
                style: const TextStyle(
                  color: MobileStackColors.warning,
                  fontSize: 11,
                ),
              ),
              const SizedBox(height: 2),
              SelectableText(
                messageFor(failedJobs[i]),
                style: const TextStyle(
                  color: MobileStackColors.muted,
                  fontSize: 10,
                  height: 1.4,
                ),
              ),
              if (i != shown - 1) const Divider(height: 16),
            ],
            if (failedJobs.length > shown) ...<Widget>[
              const SizedBox(height: 8),
              Text(
                'ほか${failedJobs.length - shown}件も失敗しています。',
                style: const TextStyle(
                  color: MobileStackColors.muted,
                  fontSize: 10,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _CountMetric extends StatelessWidget {
  const _CountMetric({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Column(
        children: <Widget>[
          Text(
            '$value',
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            style: const TextStyle(
              color: MobileStackColors.muted,
              fontSize: 10,
            ),
          ),
        ],
      ),
    );
  }
}
