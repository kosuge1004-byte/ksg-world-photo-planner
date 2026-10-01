import 'dart:io';

/// Copies background-job inputs into the job's private directory before the
/// WorkManager task is enqueued.
///
/// Android file-picker paths commonly live below the app cache directory.
/// Those cache files are not a durable contract for a deferred/background
/// worker: they may disappear after picker reuse, process death, or cache
/// cleanup. A background job must therefore own durable copies of every RAW
/// input it needs for the lifetime of the job.
final class BackgroundInputStager {
  BackgroundInputStager._();

  static Future<List<String>> stageGroup({
    required Directory jobDirectory,
    required String groupName,
    required List<String> sourcePaths,
    void Function(int current, int total)? onProgress,
    Duration metadataTimeout = const Duration(seconds: 30),
    Duration copyInactivityTimeout = const Duration(minutes: 2),
  }) async {
    if (sourcePaths.isEmpty) return const <String>[];
    if (!RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(groupName)) {
      throw ArgumentError.value(groupName, 'groupName', 'Invalid input group.');
    }

    final Directory inputsDirectory = Directory(
      '${jobDirectory.path}${Platform.pathSeparator}inputs',
    );
    final Directory destinationDirectory = Directory(
      '${inputsDirectory.path}${Platform.pathSeparator}$groupName',
    );
    await destinationDirectory.create(recursive: true);

    final List<String> staged = <String>[];
    try {
      for (int index = 0; index < sourcePaths.length; index++) {
        onProgress?.call(index + 1, sourcePaths.length);
        final String sourcePath = sourcePaths[index];
        final File source = File(sourcePath);
        if (!await source.exists().timeout(metadataTimeout)) {
          throw StateError('バックグラウンド処理用RAWが見つかりません: $sourcePath');
        }

        final int sourceLength = await source.length().timeout(metadataTimeout);
        if (sourceLength <= 0) {
          throw StateError('バックグラウンド処理用RAWが空です: $sourcePath');
        }

        final String basename = _basename(sourcePath);
        final String safeName = _safeBasename(basename);
        final String indexedName =
            '${index.toString().padLeft(5, '0')}_$safeName';
        final File destination = File(
          '${destinationDirectory.path}${Platform.pathSeparator}$indexedName',
        );
        final File temporary = File('${destination.path}.tmp');

        if (await temporary.exists()) await temporary.delete();
        // Timeout is based on inactivity, not total copy duration: very large
        // RAW sets may legitimately take minutes, but a provider/filesystem
        // that produces no bytes must not freeze job creation forever before
        // status/watchdog supervision exists.
        await source
            .openRead()
            .timeout(copyInactivityTimeout)
            .pipe(temporary.openWrite());
        final int copiedLength =
            await temporary.length().timeout(metadataTimeout);
        if (copiedLength != sourceLength) {
          await temporary.delete();
          throw StateError(
            'RAWのバックグラウンド用コピーに失敗しました: '
            '$sourcePath ($sourceLength bytes -> $copiedLength bytes)',
          );
        }
        if (await destination.exists()) await destination.delete();
        await temporary.rename(destination.path);
        staged.add(destination.path);
      }
      return List<String>.unmodifiable(staged);
    } on Object {
      // Staging is transactional for the job. If any source/calibration file
      // disappears mid-copy, discard all groups already copied for this new
      // unregistered job so large orphaned RAW files are not left behind.
      if (await jobDirectory.exists()) {
        await jobDirectory.delete(recursive: true);
      }
      rethrow;
    }
  }

  static String _basename(String path) {
    final String normalized = path.replaceAll('\\', '/');
    final int slash = normalized.lastIndexOf('/');
    return slash < 0 ? normalized : normalized.substring(slash + 1);
  }

  static String _safeBasename(String value) {
    final String sanitized = value.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
    return sanitized.isEmpty ? 'input.raw' : sanitized;
  }
}
