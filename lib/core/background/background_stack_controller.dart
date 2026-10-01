import '../quality/processing_quality_level.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:workmanager/workmanager.dart';

import 'background_task_payload.dart';
import 'background_input_stager.dart';
import 'cfa_drizzle_background_worker.dart';
import 'standard_stack_background_worker.dart';
import 'focus_stack_background_worker.dart';
import 'focus_marking_background_worker.dart';
import 'meteor_background_worker.dart';
import 'meteor_composite_background_worker.dart';
import 'remote_processor_bridge.dart';
import '../io/raw_input_contract.dart';
import '../engine/default_resource_reader.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../raw/native_raw_decoder_factory.dart';
import '../raw/raw_file_probe.dart';
import '../export/output_image_format.dart';
import '../models/processing_mode.dart';
import '../session/processing_session.dart';
import '../settings/app_settings.dart';
import 'stack_job_notifications.dart';
import 'stack_job_registry.dart';
import 'stack_job_status.dart';

final class BackgroundStoragePreflightException implements Exception {
  const BackgroundStoragePreflightException({
    required this.requiredBytes,
    required this.availableBytes,
    required this.additionalBytesNeeded,
    required this.frameCount,
    required this.width,
    required this.height,
    this.reclaimableTerminalJobBytes = 0,
  });

  final int requiredBytes;
  final int availableBytes;
  final int additionalBytesNeeded;
  final int frameCount;
  final int width;
  final int height;
  final int reclaimableTerminalJobBytes;

  static String _formatBytes(int bytes) {
    final double gib = bytes / (1024 * 1024 * 1024);
    if (gib >= 1) return '${gib.toStringAsFixed(1)} GB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(0)} MB';
  }

  @override
  String toString() => '端末の空き容量が不足しているため、処理を開始しません。\n'
      '概算必要空き容量: ${_formatBytes(requiredBytes)}\n'
      '現在の空き容量: ${_formatBytes(availableBytes)}\n'
      '${reclaimableTerminalJobBytes > 0 ? '以前の完了データを削除すると回収可能: ${_formatBytes(reclaimableTerminalJobBytes)}\n' : ''}'
      '不足容量: ${_formatBytes(additionalBytesNeeded)}\n'
      '対象: $frameCount枚 / $width×$height\n'
      '空き容量を確保してから、もう一度開始してください。';
}

const Duration _inputSizePreflightTimeout = Duration(minutes: 2);
const Duration _terminalJobSizeTimeout = Duration(seconds: 10);

Future<int> _boundedPreviousTerminalJobReclaimableBytes() async {
  try {
    return await StackJobRegistry.previousTerminalJobReclaimableBytes().timeout(
      _terminalJobSizeTimeout,
    );
  } on Object {
    // This is only an admission optimisation. Zero is conservative and keeps
    // a very large/corrupt previous job tree from freezing every new launch.
    return 0;
  }
}

Future<int> _sumExistingFileBytes(Iterable<String> paths) =>
    _sumExistingFileBytesUnchecked(paths).timeout(
      _inputSizePreflightTimeout,
      onTimeout: () => throw TimeoutException(
        '入力ファイル容量の確認が2分以内に完了しませんでした。'
        '外部ストレージの接続を確認してください。',
      ),
    );

Future<int> _sumExistingFileBytesUnchecked(Iterable<String> paths) async {
  int total = 0;
  for (final String path in paths) {
    final File file = File(path);
    if (!await file.exists()) continue;
    final int length = await file.length();
    if (length > 0) total += length;
  }
  return total;
}

Future<void> _preflightStandardStackStorage({
  required List<String> sourcePaths,
  required List<String> darkFramePaths,
  required List<String> flatFramePaths,
  required int referenceIndex,
  required ProcessingMode mode,
  required bool automaticMovingObjectRemoval,
  bool resume = false,
  int additionalFrameCopies = 0,
  int reclaimableTerminalJobBytes = 0,
}) async {
  if (sourcePaths.isEmpty) return;

  // Metadata-only probing gives us the actual RAW dimensions without paying
  // for a full demosaic/decode. If this probe is unavailable for a format,
  // defer to the worker's per-frame storage guards rather than guessing.
  final probe =
      await const RawFileProbe().probe(sourcePaths[referenceIndex]).timeout(
            const Duration(minutes: 2),
            onTimeout: () => throw TimeoutException(
              'RAW入力の事前確認が2分以内に完了しませんでした。',
            ),
          );
  if (!probe.isAccepted) return;
  final metadataProbe = createProductionNativeRawMetadataProbe();
  if (!metadataProbe.supports(probe.format)) return;
  final metadata = await metadataProbe.probe(probe).timeout(
        const Duration(minutes: 2),
        onTimeout: () => throw TimeoutException(
          'RAW寸法の事前確認が2分以内に完了しませんでした。',
        ),
      );
  if (metadata.width <= 0 || metadata.height <= 0) return;

  final int frameBytes = metadata.width *
      metadata.height *
      FileBackedLinearRgbTileStore.bytesPerPixel;

  // BackgroundInputStager creates durable private copies of every selected
  // RAW/calibration frame before the processor starts. Count those bytes up
  // front so the user is not made to wait for a large staging copy only to
  // discover afterwards that the actual processing cannot fit.
  final int stagedInputBytes = resume
      ? 0
      : await _sumExistingFileBytes(<String>[
          ...sourcePaths,
          ...darkFramePaths,
          ...flatFramePaths,
        ]);

  // Star trails and movement-removal-OFF Milky Way use durable rolling
  // accumulators. Their requirements are bounded by image dimensions rather
  // than multiplied by frame count. Milky Way keeps FP64 weighted sums and
  // denominators so its result matches the batch combiner's precision.
  // Movement-removal-ON Milky Way remains the conservative all-frame path
  // because iterative kappa-sigma rejection needs simultaneous frame access.
  final bool rollingMilkyWay =
      mode == ProcessingMode.milkyWay && !automaticMovingObjectRemoval;
  final int decodedWorkingSet = mode == ProcessingMode.starTrail
      ? frameBytes * 7
      : rollingMilkyWay
          ? metadata.width * metadata.height * 186
          : frameBytes * sourcePaths.length;

  // Finalization/export reserve. For rolling star trails this covers an extra
  // durable final generation and encoder slack while keeping the previous
  // generation recoverable. No precision, resolution, or feature is reduced.
  final int modeReserve = mode == ProcessingMode.milkyWay ? frameBytes ~/ 2 : 0;
  final int postDecodeAndExportReserve =
      mode == ProcessingMode.starTrail || rollingMilkyWay
          ? 768 * 1024 * 1024
          : frameBytes * (3 + additionalFrameCopies) +
              modeReserve +
              512 * 1024 * 1024;
  final int requiredBytes =
      stagedInputBytes + decodedWorkingSet + postDecodeAndExportReserve;

  final snapshot = await readDefaultResourceSnapshot().timeout(
    const Duration(seconds: 15),
    onTimeout: () => throw TimeoutException(
      '端末の空き容量確認が15秒以内に完了しませんでした。',
    ),
  );
  final int? available = snapshot.availableStorageBytes;
  if (available == null || available < 0) return;
  final int effectiveAvailable = available + reclaimableTerminalJobBytes;
  if (effectiveAvailable < requiredBytes) {
    throw BackgroundStoragePreflightException(
      requiredBytes: requiredBytes,
      availableBytes: available,
      additionalBytesNeeded: requiredBytes - effectiveAvailable,
      frameCount: sourcePaths.length,
      width: metadata.width,
      height: metadata.height,
      reclaimableTerminalJobBytes: reclaimableTerminalJobBytes,
    );
  }
}

final class BackgroundStackLaunch {
  const BackgroundStackLaunch({
    required this.uniqueName,
    required this.statusPath,
    required this.outputPath,
    required this.frameCount,
    required this.recovered,
    this.jobKind = 'cfaDrizzle',
    this.modeName = 'milkyWay',
    this.jobLabel = '天の川スタック',
    this.sourcePaths = const <String>[],
    this.outputFormatName = 'linearDng',
    this.storagePresetName = 'maximum',
  });

  final String uniqueName;
  final String statusPath;
  final String outputPath;
  final int frameCount;
  final bool recovered;
  final String jobKind;
  final String modeName;
  final String jobLabel;
  final List<String> sourcePaths;
  final String outputFormatName;
  final String storagePresetName;
}

final class BackgroundStackController {
  BackgroundStackController._();

  static const String _workManagerUniqueName = 'cfa-drizzle-active';

  static Future<BackgroundStackLaunch>? _launchInFlight;

  static Future<void> _deleteFailedNewJobDirectory(Directory directory) async {
    try {
      if (await directory.exists()) await directory.delete(recursive: true);
    } on FileSystemException {
      // cleanupOrphanedJobDirectories() retries this before the next launch.
    }
  }

  static Future<BackgroundStackLaunch> _serializeLaunch(
    Future<BackgroundStackLaunch> Function() start,
  ) {
    final Future<BackgroundStackLaunch>? inFlight = _launchInFlight;
    if (inFlight != null) return inFlight;
    final Future<BackgroundStackLaunch> launch = () async {
      // Old staged RAW trees can be many gigabytes, so cleanup must not block
      // the user-visible launch path. The age guard plus a registry re-check
      // before each deletion protects the generation being created now.
      unawaited(() async {
        try {
          await StackJobRegistry.cleanupOrphanedJobDirectories(
            minimumAge: const Duration(minutes: 10),
          );
        } on Object {
          // Best effort; a later launch retries stale orphan cleanup.
        }
      }());
      return start();
    }();
    _launchInFlight = launch;
    return launch.whenComplete(() {
      if (identical(_launchInFlight, launch)) _launchInFlight = null;
    });
  }

  /// Registers [taskName] under [uniqueName] and confirms Android WorkManager
  /// actually kept *this* registration (identified by [jobId]'s tag) rather
  /// than an already-running one under the same unique name.
  ///
  /// `existingWorkPolicy: keep` is WorkManager's own duplicate guard, but it
  /// only prevents a *second* task from starting — it does not tell the
  /// caller whether its own registration was the one kept. Two overlapping
  /// calls into this controller (e.g. a fast double-tap on "start") can each
  /// pass the app-level `StackJobRegistry.activeJob()` check before either
  /// has written its own record, then both stage inputs and both call
  /// `registerOneOffTask` — WorkManager keeps only one, but without this
  /// check the *other* caller's `StackJobRegistry.write()` could still be
  /// the last one to land, leaving the registry pointing at a job that will
  /// never actually run. Querying `getWorkInfo` after registration and
  /// checking the tag closes that gap: if this call did not win, its own
  /// registry entry is torn down and a clear error is thrown instead of
  /// silently leaving a stale pointer behind.
  static Future<void> _registerUniqueTaskVerified({
    required String uniqueName,
    required String taskName,
    required String jobId,
    required String statusPath,
    required Map<String, dynamic> inputData,
    required ForegroundServiceConfig foregroundServiceConfig,
  }) async {
    try {
      if (Platform.isAndroid) {
        final String? payloadPath =
            inputData[BackgroundTaskPayload.inputDataKey] as String?;
        if (payloadPath == null || payloadPath.isEmpty) {
          throw StateError('バックグラウンド処理のpayloadPathがありません。');
        }
        // Android heavy processing is intentionally *not* hosted by the
        // WorkManager FlutterEngine.  ProcessorService is manifest-isolated
        // into the :processor OS process, so RAW/native stalls cannot share
        // the UI process main looper, Dart heap, or native heap.
        await RemoteProcessorBridge.start(
          taskName: taskName,
          payloadPath: payloadPath,
          statusPath: statusPath,
          uniqueName: uniqueName,
          jobId: jobId,
        );
        return;
      }

      // Keep the existing WorkManager path for non-Android platforms.
      await Workmanager().registerOneOffTask(
        uniqueName,
        taskName,
        existingWorkPolicy: ExistingWorkPolicy.keep,
        tag: jobId,
        inputData: inputData,
        foregroundServiceConfig: foregroundServiceConfig,
      );
    } on Object {
      await StackJobRegistry.clearIfMatches(
        uniqueName,
        expectedStatusPath: statusPath,
      );
      rethrow;
    }
  }

  static Future<BackgroundStackLaunch> startCfaDrizzle({
    required List<String> sourcePaths,
    List<String>? darkFramePaths,
    List<String>? flatFramePaths,
    bool enableRobustRejection = true,
    bool useComprehensiveFrameWeighting = true,
    bool usePsfRefinement = true,
    bool enableLocalRegistration = true,
  }) {
    return _serializeLaunch(
      () => _startCfaDrizzleInternal(
        sourcePaths: sourcePaths,
        darkFramePaths: darkFramePaths,
        flatFramePaths: flatFramePaths,
        enableRobustRejection: enableRobustRejection,
        useComprehensiveFrameWeighting: useComprehensiveFrameWeighting,
        usePsfRefinement: usePsfRefinement,
        enableLocalRegistration: enableLocalRegistration,
      ),
    );
  }

  static Future<BackgroundStackLaunch> _startCfaDrizzleInternal({
    required List<String> sourcePaths,
    List<String>? darkFramePaths,
    List<String>? flatFramePaths,
    bool enableRobustRejection = true,
    bool useComprehensiveFrameWeighting = true,
    bool usePsfRefinement = true,
    bool enableLocalRegistration = true,
  }) async {
    if (sourcePaths.length < 2) {
      throw ArgumentError('At least two RAW frames are required.');
    }

    await StackJobNotifications.requestPermission();

    final StackJobRecord? active = await StackJobRegistry.activeJob();
    if (active != null) {
      return BackgroundStackLaunch(
        uniqueName: active.uniqueName,
        statusPath: active.statusPath,
        outputPath: active.outputPath,
        frameCount: active.frameCount,
        recovered: true,
        jobKind: active.jobKind,
        modeName: active.modeName,
        jobLabel: active.jobLabel,
        sourcePaths: active.sourcePaths,
        outputFormatName: active.outputFormatName,
        storagePresetName: active.storagePresetName,
      );
    }

    final int reclaimableTerminalJobBytes =
        await _boundedPreviousTerminalJobReclaimableBytes();
    await _preflightStandardStackStorage(
      sourcePaths: sourcePaths,
      darkFramePaths: darkFramePaths ?? const <String>[],
      flatFramePaths: flatFramePaths ?? const <String>[],
      referenceIndex: 0,
      mode: ProcessingMode.milkyWay,
      automaticMovingObjectRemoval: true,
      // Drizzle expands the output geometry and holds additional registration
      // and rejection buffers. Reserve them before copying any input.
      additionalFrameCopies: 12,
      reclaimableTerminalJobBytes: reclaimableTerminalJobBytes,
    );
    // A completed/failed/cancelled generation is recoverable from the home
    // screen until the user starts another stack. At that point it is no
    // longer the recoverable generation, so reclaim its private result/job
    // directory before allocating another potentially very large Linear DNG.
    await StackJobRegistry.discardPreviousTerminalJob();
    await _preflightStandardStackStorage(
      sourcePaths: sourcePaths,
      darkFramePaths: darkFramePaths ?? const <String>[],
      flatFramePaths: flatFramePaths ?? const <String>[],
      referenceIndex: 0,
      mode: ProcessingMode.milkyWay,
      automaticMovingObjectRemoval: true,
      additionalFrameCopies: 12,
    );

    final Directory jobsRoot = await StackJobRegistry.jobsDirectory();
    final String jobId = 'cfa-drizzle-${DateTime.now().microsecondsSinceEpoch}';
    const String uniqueName = _workManagerUniqueName;
    final Directory jobDirectory = Directory(
      '${jobsRoot.path}${Platform.pathSeparator}$jobId',
    );
    await jobDirectory.create(recursive: true);
    final List<String> stagedSourcePaths =
        await BackgroundInputStager.stageGroup(
      jobDirectory: jobDirectory,
      groupName: 'source',
      sourcePaths: sourcePaths,
    );
    final List<String> stagedDarkFramePaths =
        await BackgroundInputStager.stageGroup(
      jobDirectory: jobDirectory,
      groupName: 'dark',
      sourcePaths: darkFramePaths ?? const <String>[],
    );
    final List<String> stagedFlatFramePaths =
        await BackgroundInputStager.stageGroup(
      jobDirectory: jobDirectory,
      groupName: 'flat',
      sourcePaths: flatFramePaths ?? const <String>[],
    );
    final String outputPath =
        '${jobDirectory.path}${Platform.pathSeparator}result.dng';
    final String statusPath =
        '${jobDirectory.path}${Platform.pathSeparator}status.json';

    final StackJobRecord record = StackJobRecord(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      sourcePaths: stagedSourcePaths,
      createdEpochMs: DateTime.now().millisecondsSinceEpoch,
      jobKind: 'cfaDrizzle',
      modeName: ProcessingMode.milkyWay.name,
      jobLabel: '天の川スタック',
    );

    late final String payloadPath;
    try {
      await StackJobStatus(
        state: StackJobState.queued,
        progress: 0,
        stage: '待機中',
        currentItem: 0,
        totalItems: stagedSourcePaths.length,
        elapsedSeconds: 0,
        updatedEpochMs: DateTime.now().millisecondsSinceEpoch,
        heartbeat: 0,
      ).writeAtomically(statusPath);
      payloadPath = await BackgroundTaskPayload.write(
        jobDirectory: jobDirectory,
        payload: <String, dynamic>{
          'sourcePaths': stagedSourcePaths,
          'darkFramePaths': stagedDarkFramePaths,
          'flatFramePaths': stagedFlatFramePaths,
          'outputPath': outputPath,
          'statusPath': statusPath,
          'enableRobustRejection': enableRobustRejection,
          'useComprehensiveFrameWeighting': useComprehensiveFrameWeighting,
          'usePsfRefinement': usePsfRefinement,
          'enableLocalRegistration': enableLocalRegistration,
        },
      );
      // Publish discoverability only after every restart prerequisite exists.
      await StackJobRegistry.write(record);
      await _registerUniqueTaskVerified(
        uniqueName: uniqueName,
        taskName: cfaDrizzleBackgroundTask,
        jobId: jobId,
        statusPath: statusPath,
        inputData: <String, dynamic>{
          BackgroundTaskPayload.inputDataKey: payloadPath,
          'statusPath': statusPath,
        },
        foregroundServiceConfig: ForegroundServiceConfig(
          notificationTitle: '天の川スタック処理中',
          notificationText: '最高画質スタックをバックグラウンドで処理しています',
          notificationChannelId: StackJobNotifications.channelId,
          notificationChannelName: StackJobNotifications.channelName,
          notificationId: StackJobNotifications.notificationId,
        ),
      );
    } on Object {
      await StackJobRegistry.clearIfMatches(
        uniqueName,
        expectedStatusPath: statusPath,
      );
      await _deleteFailedNewJobDirectory(jobDirectory);
      rethrow;
    }

    return BackgroundStackLaunch(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      frameCount: stagedSourcePaths.length,
      recovered: false,
      jobKind: 'cfaDrizzle',
      modeName: ProcessingMode.milkyWay.name,
      jobLabel: '天の川スタック',
    );
  }

  static Future<BackgroundStackLaunch> startStandardStack({
    required ProcessingSession session,
    List<String>? darkFramePaths,
    List<String>? flatFramePaths,
    void Function(String stage)? onLaunchStage,
  }) =>
      _serializeLaunch(
        () => _startStandardStackInternal(
          session: session,
          darkFramePaths: darkFramePaths,
          flatFramePaths: flatFramePaths,
          onLaunchStage: onLaunchStage,
        ),
      );

  static Future<BackgroundStackLaunch> _startStandardStackInternal({
    required ProcessingSession session,
    List<String>? darkFramePaths,
    List<String>? flatFramePaths,
    void Function(String stage)? onLaunchStage,
  }) async {
    if (session.mode != ProcessingMode.milkyWay &&
        session.mode != ProcessingMode.starTrail) {
      throw ArgumentError(
          'Standard background stack supports Milky Way/star trail only.');
    }
    final bool pureMaxReference = session.mode == ProcessingMode.starTrail &&
        session.starTrailPureMaxReference;
    final effectiveOutputFormat =
        pureMaxReference ? OutputImageFormat.linearDng : session.outputFormat;
    final effectiveQualityLevel = pureMaxReference
        ? ProcessingQualityLevel.maximum
        : session.qualityLevel;
    final List<String> originalSourcePaths = <String>[
      for (final file in session.files) file.path,
    ];
    if (originalSourcePaths.length < 2) {
      throw ArgumentError('At least two RAW frames are required.');
    }
    final int? referenceIndex = session.referenceIndex;
    if (referenceIndex == null) {
      throw StateError('基準写真が選択されていません。');
    }
    onLaunchStage?.call('通知と既存処理を確認中…');
    await StackJobNotifications.requestPermission();
    final StackJobRecord? active = await StackJobRegistry.activeJob();
    if (active != null) {
      return BackgroundStackLaunch(
        uniqueName: active.uniqueName,
        statusPath: active.statusPath,
        outputPath: active.outputPath,
        frameCount: active.frameCount,
        recovered: true,
        jobKind: active.jobKind,
        modeName: active.modeName,
        jobLabel: active.jobLabel,
        sourcePaths: active.sourcePaths,
        outputFormatName: active.outputFormatName,
        storagePresetName: active.storagePresetName,
      );
    }
    onLaunchStage?.call('入力と空き容量を確認中…');
    final int reclaimableTerminalJobBytes =
        await _boundedPreviousTerminalJobReclaimableBytes();
    // First admit against current free space plus only the bytes that a safe
    // terminal generation can actually return. If the new job still cannot
    // fit, leave the previous result untouched.
    await _preflightStandardStackStorage(
      sourcePaths: originalSourcePaths,
      darkFramePaths: darkFramePaths ?? const <String>[],
      flatFramePaths: flatFramePaths ?? const <String>[],
      referenceIndex: referenceIndex,
      mode: session.mode,
      automaticMovingObjectRemoval: session.automaticMovingObjectRemoval,
      reclaimableTerminalJobBytes: reclaimableTerminalJobBytes,
    );
    onLaunchStage?.call('前回の完了データを整理中…');
    await StackJobRegistry.discardPreviousTerminalJob();
    // Re-read real free space after deletion. A failed or partial reclaim must
    // never be treated as capacity that actually exists.
    await _preflightStandardStackStorage(
      sourcePaths: originalSourcePaths,
      darkFramePaths: darkFramePaths ?? const <String>[],
      flatFramePaths: flatFramePaths ?? const <String>[],
      referenceIndex: referenceIndex,
      mode: session.mode,
      automaticMovingObjectRemoval: session.automaticMovingObjectRemoval,
    );
    onLaunchStage?.call('入力RAWの安全なコピーを準備中…');
    final Directory jobsRoot = await StackJobRegistry.jobsDirectory();
    final String jobId =
        '${pureMaxReference ? 'pure-max-reference' : 'standard-stack'}-${DateTime.now().microsecondsSinceEpoch}';
    const String uniqueName = 'standard-stack-active';
    final Directory jobDirectory = Directory(
      '${jobsRoot.path}${Platform.pathSeparator}$jobId',
    );
    await jobDirectory.create(recursive: true);
    final List<String> sourcePaths = await BackgroundInputStager.stageGroup(
      jobDirectory: jobDirectory,
      groupName: 'source',
      sourcePaths: originalSourcePaths,
      onProgress: (int current, int total) => onLaunchStage?.call(
        '入力RAWをコピー中 ($current / $total)…',
      ),
    );
    final List<String> stagedDarkFramePaths =
        await BackgroundInputStager.stageGroup(
      jobDirectory: jobDirectory,
      groupName: 'dark',
      sourcePaths: darkFramePaths ?? const <String>[],
      onProgress: (int current, int total) => onLaunchStage?.call(
        'ダークフレームをコピー中 ($current / $total)…',
      ),
    );
    final List<String> stagedFlatFramePaths =
        await BackgroundInputStager.stageGroup(
      jobDirectory: jobDirectory,
      groupName: 'flat',
      sourcePaths: flatFramePaths ?? const <String>[],
      onProgress: (int current, int total) => onLaunchStage?.call(
        'フラットフレームをコピー中 ($current / $total)…',
      ),
    );
    final String outputPath = '${jobDirectory.path}${Platform.pathSeparator}'
        'result.${effectiveOutputFormat.extension}';
    final String statusPath =
        '${jobDirectory.path}${Platform.pathSeparator}status.json';
    final String jobLabel = pureMaxReference
        ? '比較明参照DNG'
        : (session.mode == ProcessingMode.starTrail ? '星の軌跡' : '天の川スタック');
    onLaunchStage?.call('処理システムを起動中…');
    final StackJobRecord record = StackJobRecord(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      sourcePaths: List<String>.unmodifiable(sourcePaths),
      createdEpochMs: DateTime.now().millisecondsSinceEpoch,
      jobKind: 'standardStack',
      modeName: session.mode.name,
      jobLabel: jobLabel,
      outputFormatName: effectiveOutputFormat.name,
      storagePresetName: session.storagePreset.name,
    );
    late final String payloadPath;
    try {
      await StackJobStatus(
        state: StackJobState.queued,
        progress: 0,
        stage: '待機中',
        currentItem: 0,
        totalItems: sourcePaths.length,
        elapsedSeconds: 0,
        updatedEpochMs: DateTime.now().millisecondsSinceEpoch,
        heartbeat: 0,
      ).writeAtomically(statusPath);
      payloadPath = await BackgroundTaskPayload.write(
        jobDirectory: jobDirectory,
        payload: <String, dynamic>{
          'sourcePaths': sourcePaths,
          'darkFramePaths': stagedDarkFramePaths,
          'flatFramePaths': stagedFlatFramePaths,
          'outputPath': outputPath,
          'statusPath': statusPath,
          'mode': session.mode.name,
          'referenceIndex': referenceIndex,
          'outputFormat': effectiveOutputFormat.name,
          'qualityLevel': effectiveQualityLevel.name,
          'storagePreset': session.storagePreset.name,
          'automaticMovingObjectRemoval': session.automaticMovingObjectRemoval,
          // Work351: registration model name (see MilkyWayRegistrationModel).
          'milkyWayRegistrationModel': session.wholeFieldRegistration
              ? 'guidedWholeField'
              : 'legacyRigid',
          'automaticStarTrailAircraftRemoval':
              session.automaticStarTrailAircraftRemoval,
          // Work355.
          'starTrailHotPixelRemoval': session.starTrailHotPixelRemoval,
          // Work356.
          'starTrailMeteorProtection': session.starTrailMeteorProtection,
          'starTrailMeanBackground': session.starTrailMeanBackground,
          'starTrailForegroundAverage': session.starTrailForegroundAverage,
          'foregroundRegion': session.foregroundRegion?.toJson(),
          'automaticStarTrailForegroundProtection':
              session.automaticStarTrailForegroundProtection,
          'starTrailPureMaxReference': pureMaxReference,
          'starTrailGapFillMode': session.starTrailGapFillMode.name,
          'starTrailFadeMode': session.starTrailFadeMode.name,
          'starTrailFadeCurve': session.starTrailFadeCurve.name,
          'starTrailFadeLengthFraction': session.starTrailFadeLengthFraction,
          'starTrailFadeMinWeight': session.starTrailFadeMinWeight,
        },
      );
      await StackJobRegistry.write(record);
      await _registerUniqueTaskVerified(
        uniqueName: uniqueName,
        taskName: standardStackBackgroundTask,
        jobId: jobId,
        statusPath: statusPath,
        inputData: <String, dynamic>{
          BackgroundTaskPayload.inputDataKey: payloadPath,
          'statusPath': statusPath,
        },
        foregroundServiceConfig: ForegroundServiceConfig(
          notificationTitle: '$jobLabel 処理中',
          notificationText: 'バックグラウンドで処理しています',
          notificationChannelId: StackJobNotifications.channelId,
          notificationChannelName: StackJobNotifications.channelName,
          notificationId: StackJobNotifications.notificationId,
        ),
      );
    } on Object {
      await StackJobRegistry.clearIfMatches(uniqueName,
          expectedStatusPath: statusPath);
      await _deleteFailedNewJobDirectory(jobDirectory);
      rethrow;
    }
    return BackgroundStackLaunch(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      frameCount: sourcePaths.length,
      recovered: false,
      jobKind: 'standardStack',
      modeName: session.mode.name,
      jobLabel: jobLabel,
      sourcePaths: sourcePaths,
      outputFormatName: effectiveOutputFormat.name,
      storagePresetName: session.storagePreset.name,
    );
  }

  static Future<BackgroundStackLaunch> startFocusStack({
    required List<RawInputFile> inputs,
    required int referenceIndex,
    required String outputFormatName,
    required String storagePresetName,
  }) =>
      _serializeLaunch(
        () => _startFocusStackInternal(
          inputs: inputs,
          referenceIndex: referenceIndex,
          outputFormatName: outputFormatName,
          storagePresetName: storagePresetName,
        ),
      );

  // Work353: a settings read failure must never block a launch; fall back to
  // the default (OFF, bit-identical blend).
  static Future<bool> _focusExposureNormalizationSetting() async {
    try {
      return await AppSettings.loadFocusExposureNormalization();
    } on Object {
      return AppSettings.defaultFocusExposureNormalization;
    }
  }

  static Future<bool> _focusPyramidBlendSetting() async {
    try {
      return await AppSettings.loadFocusPyramidBlend();
    } on Object {
      return AppSettings.defaultFocusPyramidBlend;
    }
  }

  static Future<bool> _meteorAdditiveCompositeSetting() async {
    try {
      return await AppSettings.loadMeteorAdditiveComposite();
    } on Object {
      return AppSettings.defaultMeteorAdditiveComposite;
    }
  }

  static Future<BackgroundStackLaunch> _startFocusStackInternal({
    required List<RawInputFile> inputs,
    required int referenceIndex,
    required String outputFormatName,
    required String storagePresetName,
  }) async {
    if (inputs.length < 2) {
      throw ArgumentError('At least two RAW frames are required.');
    }
    RangeError.checkValidIndex(referenceIndex, inputs, 'referenceIndex');
    await StackJobNotifications.requestPermission();
    final StackJobRecord? active = await StackJobRegistry.activeJob();
    if (active != null) {
      return BackgroundStackLaunch(
        uniqueName: active.uniqueName,
        statusPath: active.statusPath,
        outputPath: active.outputPath,
        frameCount: active.frameCount,
        recovered: true,
        jobKind: active.jobKind,
        modeName: active.modeName,
        jobLabel: active.jobLabel,
        sourcePaths: active.sourcePaths,
        outputFormatName: active.outputFormatName,
        storagePresetName: active.storagePresetName,
      );
    }
    final List<String> originalSourcePaths = <String>[
      for (final RawInputFile input in inputs) input.path,
    ];
    final int reclaimableTerminalJobBytes =
        await _boundedPreviousTerminalJobReclaimableBytes();
    await _preflightStandardStackStorage(
      sourcePaths: originalSourcePaths,
      darkFramePaths: const <String>[],
      flatFramePaths: const <String>[],
      referenceIndex: referenceIndex,
      mode: ProcessingMode.focusStack,
      automaticMovingObjectRemoval: true,
      reclaimableTerminalJobBytes: reclaimableTerminalJobBytes,
    );
    await StackJobRegistry.discardPreviousTerminalJob();
    await _preflightStandardStackStorage(
      sourcePaths: originalSourcePaths,
      darkFramePaths: const <String>[],
      flatFramePaths: const <String>[],
      referenceIndex: referenceIndex,
      mode: ProcessingMode.focusStack,
      automaticMovingObjectRemoval: true,
    );
    final Directory jobsRoot = await StackJobRegistry.jobsDirectory();
    final String jobId = 'focus-stack-${DateTime.now().microsecondsSinceEpoch}';
    const String uniqueName = 'focus-stack-active';
    final Directory jobDirectory =
        Directory('${jobsRoot.path}${Platform.pathSeparator}$jobId');
    await jobDirectory.create(recursive: true);
    final List<String> sourcePaths = await BackgroundInputStager.stageGroup(
      jobDirectory: jobDirectory,
      groupName: 'source',
      sourcePaths: originalSourcePaths,
    );
    final String extension = switch (outputFormatName) {
      'jpeg' => 'jpg',
      'tiff16' => 'tiff',
      _ => 'dng',
    };
    final String outputPath =
        '${jobDirectory.path}${Platform.pathSeparator}result.$extension';
    final String statusPath =
        '${jobDirectory.path}${Platform.pathSeparator}status.json';
    final StackJobRecord record = StackJobRecord(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      sourcePaths: List<String>.unmodifiable(sourcePaths),
      createdEpochMs: DateTime.now().millisecondsSinceEpoch,
      jobKind: 'focusStack',
      modeName: ProcessingMode.focusStack.name,
      jobLabel: '深度合成',
      outputFormatName: outputFormatName,
      storagePresetName: storagePresetName,
    );
    late final String payloadPath;
    try {
      await StackJobStatus(
        state: StackJobState.queued,
        progress: 0,
        stage: '待機中',
        currentItem: 0,
        totalItems: sourcePaths.length,
        elapsedSeconds: 0,
        updatedEpochMs: DateTime.now().millisecondsSinceEpoch,
        heartbeat: 0,
      ).writeAtomically(statusPath);
      payloadPath = await BackgroundTaskPayload.write(
        jobDirectory: jobDirectory,
        payload: <String, dynamic>{
          'sourcePaths': sourcePaths,
          'outputPath': outputPath,
          'statusPath': statusPath,
          'referenceIndex': referenceIndex,
          'outputFormat': outputFormatName,
          'storagePreset': storagePresetName,
          // Work353: persisted user setting, read at launch.
          'focusNormalizeExposure': await _focusExposureNormalizationSetting(),
          // Work354: 'depthMap' | 'pyramid'.
          'focusBlendMethod': await _focusPyramidBlendSetting()
              ? 'pyramid'
              : 'depthMap',
        },
      );
      await StackJobRegistry.write(record);
      await _registerUniqueTaskVerified(
        uniqueName: uniqueName,
        taskName: focusStackBackgroundTask,
        jobId: jobId,
        statusPath: statusPath,
        inputData: <String, dynamic>{
          BackgroundTaskPayload.inputDataKey: payloadPath,
          'statusPath': statusPath,
        },
        foregroundServiceConfig: ForegroundServiceConfig(
          notificationTitle: '深度合成 処理中',
          notificationText: 'バックグラウンドで深度合成しています',
          notificationChannelId: StackJobNotifications.channelId,
          notificationChannelName: StackJobNotifications.channelName,
          notificationId: StackJobNotifications.notificationId,
        ),
      );
    } on Object {
      await StackJobRegistry.clearIfMatches(uniqueName,
          expectedStatusPath: statusPath);
      await _deleteFailedNewJobDirectory(jobDirectory);
      rethrow;
    }
    return BackgroundStackLaunch(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      frameCount: sourcePaths.length,
      recovered: false,
      jobKind: 'focusStack',
      modeName: ProcessingMode.focusStack.name,
      jobLabel: '深度合成',
      sourcePaths: sourcePaths,
      outputFormatName: outputFormatName,
      storagePresetName: storagePresetName,
    );
  }

  static Future<BackgroundStackLaunch> startFocusMarking({
    required List<RawInputFile> inputs,
    required int referenceIndex,
    required bool showOmissionCandidates,
    required bool autoExcludeOmissionCandidates,
    required String outputFormatName,
    required String storagePresetName,
  }) =>
      _serializeLaunch(
        () => _startFocusMarkingInternal(
          inputs: inputs,
          referenceIndex: referenceIndex,
          showOmissionCandidates: showOmissionCandidates,
          autoExcludeOmissionCandidates: autoExcludeOmissionCandidates,
          outputFormatName: outputFormatName,
          storagePresetName: storagePresetName,
        ),
      );

  static Future<BackgroundStackLaunch> _startFocusMarkingInternal({
    required List<RawInputFile> inputs,
    required int referenceIndex,
    required bool showOmissionCandidates,
    required bool autoExcludeOmissionCandidates,
    required String outputFormatName,
    required String storagePresetName,
  }) async {
    final List<String> originalSourcePaths = <String>[
      for (final RawInputFile input in inputs) input.path
    ];
    if (originalSourcePaths.length < 2 ||
        referenceIndex < 0 ||
        referenceIndex >= originalSourcePaths.length) {
      throw ArgumentError('Invalid focus marking background input.');
    }
    await StackJobNotifications.requestPermission();
    final StackJobRecord? active = await StackJobRegistry.activeJob();
    if (active != null) {
      return BackgroundStackLaunch(
        uniqueName: active.uniqueName,
        statusPath: active.statusPath,
        outputPath: active.outputPath,
        frameCount: active.frameCount,
        recovered: true,
        jobKind: active.jobKind,
        modeName: active.modeName,
        jobLabel: active.jobLabel,
        sourcePaths: active.sourcePaths,
        outputFormatName: active.outputFormatName,
        storagePresetName: active.storagePresetName,
      );
    }
    final int reclaimableTerminalJobBytes =
        await _boundedPreviousTerminalJobReclaimableBytes();
    await _preflightStandardStackStorage(
      sourcePaths: originalSourcePaths,
      darkFramePaths: const <String>[],
      flatFramePaths: const <String>[],
      referenceIndex: referenceIndex,
      mode: ProcessingMode.focusStack,
      automaticMovingObjectRemoval: true,
      // Marking is sequential, but reserve several decoded working frames and
      // export slack so ENOSPC cannot prevent the terminal status write.
      additionalFrameCopies: 1,
      reclaimableTerminalJobBytes: reclaimableTerminalJobBytes,
    );
    await StackJobRegistry.discardPreviousTerminalJob();
    await _preflightStandardStackStorage(
      sourcePaths: originalSourcePaths,
      darkFramePaths: const <String>[],
      flatFramePaths: const <String>[],
      referenceIndex: referenceIndex,
      mode: ProcessingMode.focusStack,
      automaticMovingObjectRemoval: true,
      additionalFrameCopies: 1,
    );
    final Directory jobsRoot = await StackJobRegistry.jobsDirectory();
    final String jobId =
        'focus-marking-${DateTime.now().microsecondsSinceEpoch}';
    const String uniqueName = 'focus-marking-active';
    final Directory jobDirectory =
        Directory('${jobsRoot.path}${Platform.pathSeparator}$jobId');
    await jobDirectory.create(recursive: true);
    final List<String> sourcePaths = await BackgroundInputStager.stageGroup(
      jobDirectory: jobDirectory,
      groupName: 'source',
      sourcePaths: originalSourcePaths,
    );
    final String outputPath =
        '${jobDirectory.path}${Platform.pathSeparator}focus_marking.json';
    final String statusPath =
        '${jobDirectory.path}${Platform.pathSeparator}status.json';
    final StackJobRecord record = StackJobRecord(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      sourcePaths: List<String>.unmodifiable(sourcePaths),
      createdEpochMs: DateTime.now().millisecondsSinceEpoch,
      jobKind: 'focusMarking',
      modeName: ProcessingMode.focusStack.name,
      jobLabel: '深度合成・合焦位置解析',
      outputFormatName: outputFormatName,
      storagePresetName: storagePresetName,
    );
    late final String payloadPath;
    try {
      await StackJobStatus(
        state: StackJobState.queued,
        progress: 0,
        stage: '待機中',
        currentItem: 0,
        totalItems: sourcePaths.length,
        elapsedSeconds: 0,
        updatedEpochMs: DateTime.now().millisecondsSinceEpoch,
        heartbeat: 0,
      ).writeAtomically(statusPath);
      payloadPath = await BackgroundTaskPayload.write(
        jobDirectory: jobDirectory,
        payload: <String, dynamic>{
          'sourcePaths': sourcePaths,
          'referenceIndex': referenceIndex,
          'outputPath': outputPath,
          'statusPath': statusPath,
          'showOmissionCandidates': showOmissionCandidates,
          'autoExcludeOmissionCandidates': autoExcludeOmissionCandidates,
          'outputFormatName': outputFormatName,
          'storagePresetName': storagePresetName,
        },
      );
      await StackJobRegistry.write(record);
      await _registerUniqueTaskVerified(
        uniqueName: uniqueName,
        taskName: focusMarkingBackgroundTask,
        jobId: jobId,
        statusPath: statusPath,
        inputData: <String, dynamic>{
          BackgroundTaskPayload.inputDataKey: payloadPath,
          'statusPath': statusPath,
        },
        foregroundServiceConfig: ForegroundServiceConfig(
          notificationTitle: '深度合成・合焦位置解析中',
          notificationText: 'バックグラウンドで合焦位置を解析しています',
          notificationChannelId: StackJobNotifications.channelId,
          notificationChannelName: StackJobNotifications.channelName,
          notificationId: StackJobNotifications.notificationId,
        ),
      );
    } on Object {
      await StackJobRegistry.clearIfMatches(uniqueName,
          expectedStatusPath: statusPath);
      await _deleteFailedNewJobDirectory(jobDirectory);
      rethrow;
    }
    return BackgroundStackLaunch(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      frameCount: sourcePaths.length,
      recovered: false,
      jobKind: 'focusMarking',
      modeName: ProcessingMode.focusStack.name,
      jobLabel: '深度合成・合焦位置解析',
      sourcePaths: sourcePaths,
      outputFormatName: outputFormatName,
      storagePresetName: storagePresetName,
    );
  }

  static Future<BackgroundStackLaunch> startMeteorAnalysis({
    required ProcessingSession session,
    List<String>? darkFramePaths,
    List<String>? flatFramePaths,
    void Function(String stage)? onLaunchStage,
  }) =>
      _serializeLaunch(
        () => _startMeteorAnalysisInternal(
          session: session,
          darkFramePaths: darkFramePaths,
          flatFramePaths: flatFramePaths,
          onLaunchStage: onLaunchStage,
        ),
      );

  static Future<BackgroundStackLaunch> _startMeteorAnalysisInternal({
    required ProcessingSession session,
    List<String>? darkFramePaths,
    List<String>? flatFramePaths,
    void Function(String stage)? onLaunchStage,
  }) async {
    if (session.mode != ProcessingMode.meteor) {
      throw ArgumentError('Meteor background analysis requires meteor mode.');
    }
    final List<String> originalSourcePaths = <String>[
      for (final file in session.files) file.path
    ];
    if (originalSourcePaths.length < 2) {
      throw ArgumentError('At least two RAW frames are required.');
    }
    onLaunchStage?.call('通知と既存処理を確認中…');
    await StackJobNotifications.requestPermission();
    final StackJobRecord? active = await StackJobRegistry.activeJob();
    if (active != null) {
      return BackgroundStackLaunch(
        uniqueName: active.uniqueName,
        statusPath: active.statusPath,
        outputPath: active.outputPath,
        frameCount: active.frameCount,
        recovered: true,
        jobKind: active.jobKind,
        modeName: active.modeName,
        jobLabel: active.jobLabel,
        sourcePaths: active.sourcePaths,
        outputFormatName: active.outputFormatName,
        storagePresetName: active.storagePresetName,
      );
    }
    onLaunchStage?.call('入力と空き容量を確認中…');
    final int referenceIndex = session.referenceIndex ?? 0;
    final int reclaimableTerminalJobBytes =
        await _boundedPreviousTerminalJobReclaimableBytes();
    await _preflightStandardStackStorage(
      sourcePaths: originalSourcePaths,
      darkFramePaths: darkFramePaths ?? const <String>[],
      flatFramePaths: flatFramePaths ?? const <String>[],
      referenceIndex: referenceIndex,
      mode: ProcessingMode.meteor,
      automaticMovingObjectRemoval: true,
      reclaimableTerminalJobBytes: reclaimableTerminalJobBytes,
    );
    onLaunchStage?.call('前回の完了データを整理中…');
    await StackJobRegistry.discardPreviousTerminalJob();
    await _preflightStandardStackStorage(
      sourcePaths: originalSourcePaths,
      darkFramePaths: darkFramePaths ?? const <String>[],
      flatFramePaths: flatFramePaths ?? const <String>[],
      referenceIndex: referenceIndex,
      mode: ProcessingMode.meteor,
      automaticMovingObjectRemoval: true,
    );
    onLaunchStage?.call('入力RAWの安全なコピーを準備中…');
    final Directory jobsRoot = await StackJobRegistry.jobsDirectory();
    final String jobId =
        'meteor-analysis-${DateTime.now().microsecondsSinceEpoch}';
    const String uniqueName = 'meteor-analysis-active';
    final Directory jobDirectory =
        Directory('${jobsRoot.path}${Platform.pathSeparator}$jobId');
    await jobDirectory.create(recursive: true);
    final List<String> sourcePaths = await BackgroundInputStager.stageGroup(
      jobDirectory: jobDirectory,
      groupName: 'source',
      sourcePaths: originalSourcePaths,
      onProgress: (int current, int total) => onLaunchStage?.call(
        '入力RAWをコピー中 ($current / $total)…',
      ),
    );
    final List<String> stagedDarkFramePaths =
        await BackgroundInputStager.stageGroup(
      jobDirectory: jobDirectory,
      groupName: 'dark',
      sourcePaths: darkFramePaths ?? const <String>[],
      onProgress: (int current, int total) => onLaunchStage?.call(
        'ダークフレームをコピー中 ($current / $total)…',
      ),
    );
    final List<String> stagedFlatFramePaths =
        await BackgroundInputStager.stageGroup(
      jobDirectory: jobDirectory,
      groupName: 'flat',
      sourcePaths: flatFramePaths ?? const <String>[],
      onProgress: (int current, int total) => onLaunchStage?.call(
        'フラットフレームをコピー中 ($current / $total)…',
      ),
    );
    final String outputPath =
        '${jobDirectory.path}${Platform.pathSeparator}meteor_analysis.json';
    final String statusPath =
        '${jobDirectory.path}${Platform.pathSeparator}status.json';
    onLaunchStage?.call('処理システムを起動中…');
    final StackJobRecord record = StackJobRecord(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      sourcePaths: List<String>.unmodifiable(sourcePaths),
      createdEpochMs: DateTime.now().millisecondsSinceEpoch,
      jobKind: 'meteorAnalysis',
      modeName: ProcessingMode.meteor.name,
      jobLabel: '流星群',
      outputFormatName: session.outputFormat.name,
      storagePresetName: session.storagePreset.name,
    );
    late final String payloadPath;
    try {
      await StackJobStatus(
        state: StackJobState.queued,
        progress: 0,
        stage: '待機中',
        currentItem: 0,
        totalItems: sourcePaths.length,
        elapsedSeconds: 0,
        updatedEpochMs: DateTime.now().millisecondsSinceEpoch,
        heartbeat: 0,
      ).writeAtomically(statusPath);
      payloadPath = await BackgroundTaskPayload.write(
        jobDirectory: jobDirectory,
        payload: <String, dynamic>{
          'sourcePaths': sourcePaths,
          'darkFramePaths': stagedDarkFramePaths,
          'flatFramePaths': stagedFlatFramePaths,
          'outputPath': outputPath,
          'statusPath': statusPath,
        },
      );
      await StackJobRegistry.write(record);
      await _registerUniqueTaskVerified(
        uniqueName: uniqueName,
        taskName: meteorBackgroundTask,
        jobId: jobId,
        statusPath: statusPath,
        inputData: <String, dynamic>{
          BackgroundTaskPayload.inputDataKey: payloadPath,
          'statusPath': statusPath,
        },
        foregroundServiceConfig: ForegroundServiceConfig(
          notificationTitle: '流星群 解析中',
          notificationText: 'バックグラウンドで流星候補を解析しています',
          notificationChannelId: StackJobNotifications.channelId,
          notificationChannelName: StackJobNotifications.channelName,
          notificationId: StackJobNotifications.notificationId,
        ),
      );
    } on Object {
      await StackJobRegistry.clearIfMatches(uniqueName,
          expectedStatusPath: statusPath);
      await _deleteFailedNewJobDirectory(jobDirectory);
      rethrow;
    }
    return BackgroundStackLaunch(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      frameCount: sourcePaths.length,
      recovered: false,
      jobKind: 'meteorAnalysis',
      modeName: ProcessingMode.meteor.name,
      jobLabel: '流星群',
      sourcePaths: sourcePaths,
      outputFormatName: session.outputFormat.name,
      storagePresetName: session.storagePreset.name,
    );
  }

  static Future<BackgroundStackLaunch> startMeteorComposite({
    required BackgroundStackLaunch analysisLaunch,
    required List<int> selectedCandidateIndices,
  }) =>
      _serializeLaunch(
        () => _startMeteorCompositeInternal(
          analysisLaunch: analysisLaunch,
          selectedCandidateIndices: selectedCandidateIndices,
        ),
      );

  static Future<BackgroundStackLaunch> _startMeteorCompositeInternal({
    required BackgroundStackLaunch analysisLaunch,
    required List<int> selectedCandidateIndices,
  }) async {
    if (analysisLaunch.jobKind != 'meteorAnalysis' ||
        selectedCandidateIndices.isEmpty) {
      throw ArgumentError('Invalid meteor composite background input.');
    }
    await StackJobNotifications.requestPermission();
    final Directory jobDirectory = File(analysisLaunch.outputPath).parent;
    if (!await File(analysisLaunch.outputPath).exists()) {
      throw StateError('流星候補解析結果が見つかりません。');
    }
    final OutputImageFormat outputFormat = OutputImageFormat.values.firstWhere(
      (OutputImageFormat value) =>
          value.name == analysisLaunch.outputFormatName,
      orElse: () => OutputImageFormat.linearDng,
    );
    final String outputPath =
        '${jobDirectory.path}${Platform.pathSeparator}meteor_result.${outputFormat.extension}';
    final String statusPath =
        '${jobDirectory.path}${Platform.pathSeparator}meteor_composite_status.json';
    const String uniqueName = 'meteor-composite-active';
    final StackJobRecord record = StackJobRecord(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      sourcePaths: List<String>.unmodifiable(analysisLaunch.sourcePaths),
      createdEpochMs: DateTime.now().millisecondsSinceEpoch,
      jobKind: 'meteorComposite',
      modeName: ProcessingMode.meteor.name,
      jobLabel: '流星群・最終合成',
      outputFormatName: analysisLaunch.outputFormatName,
      storagePresetName: analysisLaunch.storagePresetName,
    );
    late final String payloadPath;
    final String jobId = jobDirectory.path.split(Platform.pathSeparator).last;
    try {
      await StackJobStatus(
        state: StackJobState.queued,
        progress: 0,
        stage: '待機中',
        currentItem: 0,
        totalItems: selectedCandidateIndices.length,
        elapsedSeconds: 0,
        updatedEpochMs: DateTime.now().millisecondsSinceEpoch,
        heartbeat: 0,
      ).writeAtomically(statusPath);
      payloadPath = await BackgroundTaskPayload.write(
        jobDirectory: jobDirectory,
        outputFileName: 'meteor_composite_input.json',
        payload: <String, dynamic>{
          'analysisPath': analysisLaunch.outputPath,
          'sourcePaths': analysisLaunch.sourcePaths,
          'selectedCandidateIndices': selectedCandidateIndices,
          // Work357: 'lighten' (historical) | 'additive'.
          'meteorCompositeBlendMode': await _meteorAdditiveCompositeSetting()
              ? 'additive'
              : 'lighten',
          'outputPath': outputPath,
          'statusPath': statusPath,
          'outputFormat': analysisLaunch.outputFormatName,
          'storagePreset': analysisLaunch.storagePresetName,
        },
      );
      await StackJobRegistry.write(record);
      await _registerUniqueTaskVerified(
        uniqueName: uniqueName,
        taskName: meteorCompositeBackgroundTask,
        jobId: jobId,
        statusPath: statusPath,
        inputData: <String, dynamic>{
          BackgroundTaskPayload.inputDataKey: payloadPath,
          'statusPath': statusPath,
        },
        foregroundServiceConfig: ForegroundServiceConfig(
          notificationTitle: '流星群・最終合成中',
          notificationText: 'バックグラウンドで最終画像を合成しています',
          notificationChannelId: StackJobNotifications.channelId,
          notificationChannelName: StackJobNotifications.channelName,
          notificationId: StackJobNotifications.notificationId,
        ),
      );
    } on Object {
      // The analysis result and its staged RAW files are still valid. Restore
      // their discoverability so a failed composite launch never strands the
      // person with an unusable queued record.
      await StackJobRegistry.write(
        StackJobRecord(
          uniqueName: analysisLaunch.uniqueName,
          statusPath: analysisLaunch.statusPath,
          outputPath: analysisLaunch.outputPath,
          sourcePaths: analysisLaunch.sourcePaths,
          createdEpochMs: DateTime.now().millisecondsSinceEpoch,
          jobKind: analysisLaunch.jobKind,
          modeName: analysisLaunch.modeName,
          jobLabel: analysisLaunch.jobLabel,
          outputFormatName: analysisLaunch.outputFormatName,
          storagePresetName: analysisLaunch.storagePresetName,
        ),
      );
      rethrow;
    }
    return BackgroundStackLaunch(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      frameCount: analysisLaunch.frameCount,
      recovered: false,
      jobKind: 'meteorComposite',
      modeName: ProcessingMode.meteor.name,
      jobLabel: '流星群・最終合成',
      sourcePaths: analysisLaunch.sourcePaths,
      outputFormatName: analysisLaunch.outputFormatName,
      storagePresetName: analysisLaunch.storagePresetName,
    );
  }

  /// Force-restarts only Android's isolated `:processor` process and reuses
  /// the already-persisted payload/status/checkpoints. The UI process is not
  /// restarted. This is intended for the explicit "processor unresponsive"
  /// recovery control, not normal cancellation.
  static Future<void> restartProcessor(BackgroundStackLaunch launch) async {
    if (!Platform.isAndroid) {
      throw UnsupportedError('処理システム単独再起動はAndroid専用です。');
    }
    final String taskName = switch (launch.jobKind) {
      'cfaDrizzle' => cfaDrizzleBackgroundTask,
      'standardStack' => standardStackBackgroundTask,
      'focusStack' => focusStackBackgroundTask,
      'focusMarking' => focusMarkingBackgroundTask,
      'meteorAnalysis' => meteorBackgroundTask,
      'meteorComposite' => meteorCompositeBackgroundTask,
      _ => throw StateError('不明なバックグラウンド処理です: ${launch.jobKind}'),
    };
    final File statusFile = File(launch.statusPath);
    final String payloadFileName = launch.jobKind == 'meteorComposite'
        ? 'meteor_composite_input.json'
        : BackgroundTaskPayload.fileName;
    final String payloadPath =
        '${statusFile.parent.path}${Platform.pathSeparator}$payloadFileName';
    final File payloadFile = File(payloadPath);
    if (!await payloadFile.exists()) {
      throw StateError('再開用の処理ペイロードが見つかりません。');
    }
    if (launch.jobKind == 'standardStack' ||
        launch.jobKind == 'cfaDrizzle' ||
        launch.jobKind == 'focusStack' ||
        launch.jobKind == 'focusMarking' ||
        launch.jobKind == 'meteorAnalysis' ||
        launch.jobKind == 'meteorComposite') {
      // New-launch entry points all admit against free storage before
      // starting (see the `_preflightStandardStackStorage` calls in
      // `_startStandardStackInternal` / the cfaDrizzle and focusStack start
      // paths); this resume path used to skip that check entirely for every
      // job kind and hand the already-persisted payload straight to
      // RemoteProcessorBridge.restart, so a job left "resume from
      // checkpoint" on a now near-full device would restart anyway and only
      // fail later, mid-frame, inside the worker's own storage guard.
      //
      // cfaDrizzle and focusStack payloads do not carry a 'mode' field (the
      // new-start path calls _preflightStandardStackStorage with a fixed
      // ProcessingMode for each), so mode/referenceIndex/dark+flat-frame
      // handling below has to branch per job kind rather than reading a
      // uniform shape. All six job kinds now re-check remaining capacity;
      // their sources are already staged, so resume never charges staging again.
      final Object? decoded = jsonDecode(await payloadFile.readAsString());
      if (decoded is! Map) {
        // Valid JSON that isn't an object (`[]`, `null`, `"abc"`, ...)
        // previously fell through this whole preflight block silently and
        // went straight to RemoteProcessorBridge.restart — no capacity
        // check, and no error either. Treat it the same as an unparsable
        // payload: refuse rather than restart unchecked.
        throw StateError('再開用ペイロードの内容を確認できませんでした。');
      }
      final Map<String, dynamic> payload = Map<String, dynamic>.from(decoded);
      List<String> stringList(Object? value) => value is List
          ? value.whereType<String>().toList(growable: false)
          : const <String>[];
      final List<String> sourcePaths = stringList(payload['sourcePaths']);
      if (sourcePaths.isEmpty) {
        // A payload this resume path cannot parse (missing/renamed fields
        // from a future app version) must not silently skip the capacity
        // check; refuse the resume rather than restart unchecked.
        throw StateError('再開用ペイロードの内容を確認できませんでした。');
      }
      switch (launch.jobKind) {
        case 'standardStack':
          final Object? modeName = payload['mode'];
          ProcessingMode? mode;
          if (modeName is String) {
            for (final ProcessingMode candidate in ProcessingMode.values) {
              if (candidate.name == modeName) {
                mode = candidate;
                break;
              }
            }
          }
          if (mode == null) {
            throw StateError('再開用ペイロードの内容を確認できませんでした。');
          }
          final Object? referenceIndexValue = payload['referenceIndex'];
          final int referenceIndex =
              referenceIndexValue is int ? referenceIndexValue : 0;
          await _preflightStandardStackStorage(
            resume: true,
            sourcePaths: sourcePaths,
            darkFramePaths: stringList(payload['darkFramePaths']),
            flatFramePaths: stringList(payload['flatFramePaths']),
            referenceIndex: referenceIndex.clamp(0, sourcePaths.length - 1),
            mode: mode,
            // Matches star_trail/milky_way worker's own default when this
            // field is absent from an older payload (true), not the
            // opposite default this resume path previously used (false)
            // — a mismatch that under-counted the capacity a genuine
            // moving-object-removal resume would need. See
            // meteor_composite_background_worker.dart / the worker this
            // payload feeds for the authoritative default.
            automaticMovingObjectRemoval:
                payload['automaticMovingObjectRemoval'] != false,
          );
        case 'cfaDrizzle':
          await _preflightStandardStackStorage(
            resume: true,
            sourcePaths: sourcePaths,
            darkFramePaths: stringList(payload['darkFramePaths']),
            flatFramePaths: stringList(payload['flatFramePaths']),
            referenceIndex: 0,
            mode: ProcessingMode.milkyWay,
            automaticMovingObjectRemoval: true,
            additionalFrameCopies: 12,
          );
        case 'focusMarking':
        case 'focusStack':
          final Object? referenceIndexValue = payload['referenceIndex'];
          final int referenceIndex =
              referenceIndexValue is int ? referenceIndexValue : 0;
          await _preflightStandardStackStorage(
            resume: true,
            sourcePaths: sourcePaths,
            darkFramePaths: const <String>[],
            flatFramePaths: const <String>[],
            referenceIndex: referenceIndex.clamp(0, sourcePaths.length - 1),
            mode: ProcessingMode.focusStack,
            automaticMovingObjectRemoval: true,
            additionalFrameCopies: launch.jobKind == 'focusMarking' ? 1 : 0,
          );
        case 'meteorAnalysis':
          await _preflightStandardStackStorage(
              resume: true,
              sourcePaths: sourcePaths,
              darkFramePaths: const [],
              flatFramePaths: const [],
              referenceIndex: 0,
              mode: ProcessingMode.meteor,
              automaticMovingObjectRemoval: true,
              additionalFrameCopies: 3);
        case 'meteorComposite':
          final analysisPath = payload['analysisPath'];
          if (analysisPath is! String) throw StateError('流星解析の保存先がありません。');
          final analysis =
              jsonDecode(await File(analysisPath).readAsString()) as Map;
          final stores = (analysis['stores'] as List).whereType<Map>().toList();
          if (stores.isEmpty) throw StateError('流星合成の保存画像がありません。');
          final width = (stores.first['width'] as num).toInt();
          final height = (stores.first['height'] as num).toInt();
          if (width <= 0 || height <= 0) throw StateError('流星合成の画像寸法が不正です。');
          final required =
              width * height * FileBackedLinearRgbTileStore.bytesPerPixel * 3 +
                  512 * 1024 * 1024;
          final resource = await readDefaultResourceSnapshot()
              .timeout(const Duration(seconds: 15));
          final available = resource.availableStorageBytes;
          if (available != null && available < required) {
            throw BackgroundStoragePreflightException(
                requiredBytes: required,
                availableBytes: available,
                additionalBytesNeeded: required - available,
                frameCount: sourcePaths.length,
                width: width,
                height: height);
          }
      }
    }
    await RemoteProcessorBridge.restart(
      taskName: taskName,
      payloadPath: payloadPath,
      statusPath: launch.statusPath,
      uniqueName: launch.uniqueName,
      jobId: statusFile.parent.path.split(Platform.pathSeparator).last,
    );
  }

  /// Requests that the running background job persisting status to
  /// [statusPath] stop at its next safe point (between frames/tiles — see
  /// `StackJobReporter.cancellationRequested`'s doc comment for why this
  /// cannot interrupt a native call already in progress).
  ///
  /// Deliberately does **not** also call `Workmanager().cancelByUniqueName()`.
  /// That API can lead Android to tear down the underlying worker/service
  /// abruptly rather than waiting for it to unwind — which would race
  /// against, and could pre-empt, the graceful shutdown this marker
  /// triggers (finish the current safe point, call `StackJobReporter.cancel()`,
  /// write a clean `cancelled` status and notification, then return `true`
  /// from the task callback so WorkManager considers it done on its own).
  /// The worker returning `true` itself already resolves WorkManager's own
  /// bookkeeping; forcing an external cancel on top only risks losing the
  /// clean terminal status to an abrupt kill instead.
  static Future<void> requestCancellation(String statusPath) {
    return StackJobStatus.requestCancellation(statusPath);
  }

  /// Abandons a recoverable job that cannot or should not be resumed.
  ///
  /// The marker is written before stopping Android services so even a late
  /// delivery of an already-accepted ProcessorService intent cannot begin
  /// work with files the user has abandoned. After the services are stopped,
  /// large job data is deleted immediately while the small status and marker
  /// files remain as a tombstone for any late cross-process delivery.
  static Future<void> abandonRecoverableJob(
      BackgroundStackLaunch launch) async {
    final StackJobStatus? current =
        await StackJobStatus.readFile(launch.statusPath);
    if (current == null ||
        current.state != StackJobState.interruptedRecoverable) {
      throw StateError('破棄できる中断ジョブがありません。');
    }
    final File marker = File('${launch.statusPath}.abandon');
    await marker.writeAsString(
      DateTime.now().millisecondsSinceEpoch.toString(),
      flush: true,
    );
    if (Platform.isAndroid) {
      try {
        await RemoteProcessorBridge.abandon(
          statusPath: launch.statusPath,
          jobId: File(launch.statusPath)
              .parent
              .path
              .split(Platform.pathSeparator)
              .last,
        );
      } on Object {
        // The durable marker remains authoritative even if the UI process
        // cannot confirm service shutdown. Processor and supervisor both
        // reject the marked generation on their next delivery/poll.
      }
    }
    await current
        .copyWith(
          state: StackJobState.cancelled,
          stage: '破棄済み',
          updatedEpochMs: DateTime.now().millisecondsSinceEpoch,
          progressEpochMs: DateTime.now().millisecondsSinceEpoch,
          clearError: true,
          clearRecoveryCause: true,
        )
        .writeAtomically(launch.statusPath);
    await StackJobRegistry.clearIfMatches(
      launch.uniqueName,
      expectedStatusPath: launch.statusPath,
    );
    await StackJobRegistry.purgeAbandonedJobData(
      statusPath: launch.statusPath,
      outputPath: launch.outputPath,
    );
  }
}
