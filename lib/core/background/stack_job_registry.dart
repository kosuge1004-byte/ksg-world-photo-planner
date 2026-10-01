import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'stack_job_status.dart';

final class StackJobRecord {
  const StackJobRecord({
    required this.uniqueName,
    required this.statusPath,
    required this.outputPath,
    required this.sourcePaths,
    required this.createdEpochMs,
    this.jobKind = 'cfaDrizzle',
    this.modeName = 'milkyWay',
    this.jobLabel = '天の川スタック',
    this.outputFormatName = 'linearDng',
    this.storagePresetName = 'maximum',
  });

  final String uniqueName;
  final String statusPath;
  final String outputPath;
  final List<String> sourcePaths;
  final int createdEpochMs;
  final String jobKind;
  final String modeName;
  final String jobLabel;
  final String outputFormatName;
  final String storagePresetName;

  int get frameCount => sourcePaths.length;

  Map<String, dynamic> toMap() => <String, dynamic>{
        'uniqueName': uniqueName,
        'statusPath': statusPath,
        'outputPath': outputPath,
        'sourcePaths': sourcePaths,
        'createdEpochMs': createdEpochMs,
        'jobKind': jobKind,
        'modeName': modeName,
        'jobLabel': jobLabel,
        'outputFormatName': outputFormatName,
        'storagePresetName': storagePresetName,
      };

  static StackJobRecord? fromMap(Map<String, dynamic> map) {
    final String? uniqueName = map['uniqueName'] as String?;
    final String? statusPath = map['statusPath'] as String?;
    final String? outputPath = map['outputPath'] as String?;
    final List<dynamic>? rawSourcePaths = map['sourcePaths'] as List<dynamic>?;
    if (uniqueName == null ||
        uniqueName.isEmpty ||
        statusPath == null ||
        statusPath.isEmpty ||
        outputPath == null ||
        outputPath.isEmpty ||
        rawSourcePaths == null) {
      return null;
    }
    final List<String> sourcePaths = <String>[];
    for (final dynamic value in rawSourcePaths) {
      if (value is! String || value.isEmpty) return null;
      sourcePaths.add(value);
    }
    return StackJobRecord(
      uniqueName: uniqueName,
      statusPath: statusPath,
      outputPath: outputPath,
      sourcePaths: sourcePaths,
      createdEpochMs: (map['createdEpochMs'] as num?)?.toInt() ?? 0,
      jobKind: map['jobKind'] as String? ?? 'cfaDrizzle',
      modeName: map['modeName'] as String? ?? 'milkyWay',
      jobLabel: map['jobLabel'] as String? ?? '天の川スタック',
      outputFormatName: map['outputFormatName'] as String? ?? 'linearDng',
      storagePresetName: map['storagePresetName'] as String? ?? 'maximum',
    );
  }
}

final class StackJobRegistry {
  StackJobRegistry._();

  static const String _registryFileName = 'active_cfa_drizzle_job.json';
  static const String _jobsDirectoryName = 'background_stack_jobs';

  static Future<Directory> jobsDirectory() async {
    final Directory support = await getApplicationSupportDirectory();
    final Directory directory =
        Directory(p.join(support.path, _jobsDirectoryName));
    await directory.create(recursive: true);
    return directory;
  }

  static Future<String> _registryPath() async {
    final Directory support = await getApplicationSupportDirectory();
    return p.join(support.path, _registryFileName);
  }

  static Future<void> write(StackJobRecord record) async {
    final String path = await _registryPath();
    final File file = File(path);
    await file.parent.create(recursive: true);
    final File temporary = File(
      '$path.tmp.$pid.${DateTime.now().microsecondsSinceEpoch}',
    );
    try {
      await temporary.writeAsString(jsonEncode(record.toMap()), flush: true);
      // Preserve the previous registry until the replacement is ready.
      // File.rename replaces an existing file/link, so deleting it first only
      // widens the crash window and is unnecessary.
      await temporary.rename(path);
    } finally {
      if (await temporary.exists()) {
        await temporary.delete();
      }
    }
  }

  static Future<StackJobRecord?> read() async {
    final File file = File(await _registryPath());
    if (!await file.exists()) return null;
    try {
      final Object? decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map<String, dynamic>) return null;
      return StackJobRecord.fromMap(decoded);
    } on Object {
      return null;
    }
  }

  /// Returns the last registered job while its persisted status can still be
  /// inspected. Terminal jobs are intentionally retained so an app restart
  /// after completion/failure can surface the outcome instead of losing it.
  static Future<StackJobRecord?> recoverableJob() async {
    final StackJobRecord? record = await read();
    if (record == null) return null;
    final StackJobStatus? status =
        await StackJobStatus.readFile(record.statusPath);
    if (status != null) return record;
    return null;
  }

  static Future<StackJobRecord?> activeJob() async {
    final StackJobRecord? record = await recoverableJob();
    if (record == null) return null;
    final StackJobStatus? status =
        await StackJobStatus.readFile(record.statusPath);
    if (status == null) return null;
    if (status.state != StackJobState.queued &&
        status.state != StackJobState.running &&
        status.state != StackJobState.interruptedRecoverable) {
      return null;
    }

    // Android heavy work is hosted by ProcessorService in a dedicated
    // :processor OS process, not by WorkManager. The persisted status file is
    // therefore the cross-process authority. A stale heartbeat is surfaced by
    // the UI as a stalled processor, but is deliberately *not* converted to a
    // terminal state here: Android may be in the middle of restarting the
    // redelivered foreground Service after killing only the processor process.
    // Treating that window as failure would destroy resumability and could
    // allow a duplicate job to start.
    return record;
  }

  /// Reclaims job directories that are not referenced by the durable registry.
  /// A failed launch can otherwise leave many gigabytes of staged RAW files
  /// that no UI path can discover or delete.
  static Future<void> cleanupOrphanedJobDirectories({
    Duration minimumAge = Duration.zero,
  }) async {
    final Directory root = await jobsDirectory();
    final DateTime oldestEligible = DateTime.now().subtract(minimumAge);
    try {
      await for (final FileSystemEntity entity
          in root.list(followLinks: false)) {
        if (entity is! Directory) continue;
        final String candidate = p.normalize(p.absolute(entity.path));
        final String name = p.basename(candidate);
        if (!_isManagedJobDirectoryName(name)) continue;
        try {
          // Launch cleanup runs concurrently with creation of the next job.
          // Never touch a freshly-created directory during the small window
          // before its durable registry record is written.
          if (minimumAge > Duration.zero) {
            final FileStat stat = await entity.stat();
            if (stat.modified.isAfter(oldestEligible)) continue;
          }

          // Re-read the registry immediately before deletion. A launch can
          // publish a new record while this best-effort scan is in progress.
          final StackJobRecord? retained = await read();
          final String? retainedDirectory = retained == null
              ? null
              : p.normalize(
                  p.absolute(File(retained.statusPath).parent.path),
                );
          if (candidate == retainedDirectory) continue;
          await entity.delete(recursive: true);
        } on FileSystemException {
          // A later launch retries cleanup; never block a usable active job.
        }
      }
    } on FileSystemException {
      // Best effort only.
    }
  }

  static bool _isManagedJobDirectoryName(String name) =>
      name.startsWith('cfa-drizzle-') ||
      name.startsWith('standard-stack-') ||
      name.startsWith('focus-stack-') ||
      name.startsWith('focus-marking-') ||
      name.startsWith('meteor-analysis-');

  static Future<void> clearIfMatches(
    String uniqueName, {
    String? expectedStatusPath,
  }) async {
    final StackJobRecord? record = await read();
    if (record == null || record.uniqueName != uniqueName) return;
    if (expectedStatusPath != null && record.statusPath != expectedStatusPath) {
      return;
    }
    final File file = File(await _registryPath());
    if (await file.exists()) await file.delete();
  }

  /// Deletes a terminal background-stack job only when all persisted paths
  /// are inside this app's managed background job directory.
  ///
  /// The fixed WorkManager unique name is deliberately *not* sufficient to
  /// identify a job: every generation uses the same native unique name. The
  /// status path is therefore used as the per-generation identity before the
  /// registry is cleared, preventing an old result screen from deleting a
  /// newer job's registry.
  static Future<bool> discardTerminalJob({
    required String uniqueName,
    required String statusPath,
    required String outputPath,
  }) async {
    final StackJobStatus? status = await StackJobStatus.readFile(statusPath);
    if (status == null ||
        status.state == StackJobState.queued ||
        status.state == StackJobState.running ||
        status.state == StackJobState.interruptedRecoverable) {
      return false;
    }

    final Directory root = await jobsDirectory();
    final Directory jobDirectory = File(statusPath).parent;
    final String canonicalRoot = p.normalize(p.absolute(root.path));
    final String canonicalJob = p.normalize(p.absolute(jobDirectory.path));
    final String canonicalStatus = p.normalize(p.absolute(statusPath));
    final String canonicalOutput = p.normalize(p.absolute(outputPath));

    final bool safeManagedJob = p.isWithin(canonicalRoot, canonicalJob) &&
        (p.basename(canonicalJob).startsWith('cfa-drizzle-') ||
            p.basename(canonicalJob).startsWith('standard-stack-') ||
            p.basename(canonicalJob).startsWith('focus-stack-') ||
            p.basename(canonicalJob).startsWith('focus-marking-') ||
            p.basename(canonicalJob).startsWith('meteor-analysis-')) &&
        p.dirname(canonicalStatus) == canonicalJob &&
        p.dirname(canonicalOutput) == canonicalJob;
    if (!safeManagedJob) return false;

    // Delete the generation-specific directory first. If the process dies
    // before registry cleanup, recoverableJob() simply sees a stale record and
    // returns null. The inverse ordering could clear discoverability while
    // leaving a very large Linear DNG orphaned indefinitely.
    try {
      if (await jobDirectory.exists()) {
        await jobDirectory.delete(recursive: true);
      }
    } on FileSystemException {
      return false;
    }

    await clearIfMatches(
      uniqueName,
      expectedStatusPath: statusPath,
    );
    return true;
  }

  /// Reclaims the large inputs, checkpoints, and output of an abandoned job
  /// immediately while retaining the tiny status and abandon-marker files.
  ///
  /// The marker must outlive the data: a late redelivery of an already
  /// accepted ProcessorService intent checks it before opening the payload.
  /// Keeping that tombstone closes the cross-process race without making the
  /// user wait for a later orphan-cleanup pass to recover storage.
  static Future<bool> purgeAbandonedJobData({
    required String statusPath,
    required String outputPath,
  }) async {
    final Directory root = await jobsDirectory();
    final Directory jobDirectory = File(statusPath).parent;
    final String canonicalRoot = p.normalize(p.absolute(root.path));
    final String canonicalJob = p.normalize(p.absolute(jobDirectory.path));
    final String canonicalStatus = p.normalize(p.absolute(statusPath));
    final String canonicalOutput = p.normalize(p.absolute(outputPath));
    final bool safeManagedJob = p.isWithin(canonicalRoot, canonicalJob) &&
        _isManagedJobDirectoryName(p.basename(canonicalJob)) &&
        p.dirname(canonicalStatus) == canonicalJob &&
        p.dirname(canonicalOutput) == canonicalJob;
    if (!safeManagedJob || !await jobDirectory.exists()) return false;

    final Set<String> retainedPaths = <String>{
      canonicalStatus,
      p.normalize(p.absolute('$statusPath.abandon')),
    };
    try {
      await for (final FileSystemEntity entity
          in jobDirectory.list(followLinks: false)) {
        final String candidate = p.normalize(p.absolute(entity.path));
        if (retainedPaths.contains(candidate)) continue;
        await entity.delete(recursive: entity is Directory);
      }
    } on FileSystemException {
      // A later orphan cleanup retries the generation. The tombstone remains
      // authoritative, so partial cleanup cannot accidentally resume it.
      return false;
    }
    return true;
  }

  /// Returns the number of bytes occupied by the currently registered terminal
  /// generation when it is safe for this app to reclaim that generation.
  /// Active and recoverable-interrupted jobs intentionally report zero.
  static Future<int> previousTerminalJobReclaimableBytes() async {
    final StackJobRecord? record = await read();
    if (record == null) return 0;
    final StackJobStatus? status =
        await StackJobStatus.readFile(record.statusPath);
    if (status == null ||
        status.state == StackJobState.queued ||
        status.state == StackJobState.running ||
        status.state == StackJobState.interruptedRecoverable) {
      return 0;
    }

    final Directory root = await jobsDirectory();
    final Directory jobDirectory = File(record.statusPath).parent;
    final String canonicalRoot = p.normalize(p.absolute(root.path));
    final String canonicalJob = p.normalize(p.absolute(jobDirectory.path));
    final String canonicalStatus = p.normalize(p.absolute(record.statusPath));
    final String canonicalOutput = p.normalize(p.absolute(record.outputPath));
    final bool safeManagedJob = p.isWithin(canonicalRoot, canonicalJob) &&
        (p.basename(canonicalJob).startsWith('cfa-drizzle-') ||
            p.basename(canonicalJob).startsWith('standard-stack-') ||
            p.basename(canonicalJob).startsWith('focus-stack-') ||
            p.basename(canonicalJob).startsWith('focus-marking-') ||
            p.basename(canonicalJob).startsWith('meteor-analysis-')) &&
        p.dirname(canonicalStatus) == canonicalJob &&
        p.dirname(canonicalOutput) == canonicalJob;
    if (!safeManagedJob || !await jobDirectory.exists()) return 0;

    int total = 0;
    try {
      await for (final FileSystemEntity entity
          in jobDirectory.list(recursive: true, followLinks: false)) {
        if (entity is File) {
          try {
            total += await entity.length();
          } on FileSystemException {
            // A concurrently disappearing file only makes this estimate more
            // conservative. Do not fail the new-job preflight for it.
          }
        }
      }
    } on FileSystemException {
      return 0;
    }
    return total;
  }

  /// Reclaims the previous terminal generation before a new highest-quality
  /// stack is created. Active queued/running jobs are never touched.
  static Future<void> discardPreviousTerminalJob() async {
    final StackJobRecord? record = await read();
    if (record == null) return;
    await discardTerminalJob(
      uniqueName: record.uniqueName,
      statusPath: record.statusPath,
      outputPath: record.outputPath,
    );
  }
}
