import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// Append-only, crash/freeze-surviving diagnostic log.
///
/// Written from the background processing isolate as plain synchronous file
/// appends (flushed immediately), so if the app or device becomes
/// unresponsive, whatever was logged up to that point is still on disk when
/// the app is later restarted. This does not require adb, a PC, or USB
/// debugging — the log file lives in normal app storage and can be copied
/// to the clipboard as plain text (see
/// [SettingsScreen] "診断ログをコピー").
///
/// Deliberately minimal: one line per event, timestamp + optional memory
/// usage (RSS) + message. Not a general logging framework.
class DiagnosticLog {
  DiagnosticLog._();

  static File? _cachedFile;
  static Future<void> _writeTail = Future<void>.value();
  static final Map<String, DateTime> _lastRateLimitedWrite =
      <String, DateTime>{};

  static Future<File> _file() async {
    final File? cached = _cachedFile;
    if (cached != null) return cached;
    final Directory dir = await getApplicationDocumentsDirectory();
    final File file = File('${dir.path}/mobile_stack_diagnostic_log.txt');
    _cachedFile = file;
    return file;
  }

  /// Work363: the run before the current one, kept so an automatic resume
  /// (which starts a new run) does not erase the log of the run that failed.
  static Future<File> _previousFile() async {
    final File current = await _file();
    // _file() always names the log "...diagnostic_log.txt".
    final String path = current.path;
    final String stem =
        path.endsWith('.txt') ? path.substring(0, path.length - 4) : path;
    return File('${stem}_previous.txt');
  }

  /// Starts a fresh log for a new processing run. The previous run's log is
  /// moved to `..._previous.txt` (Work363; only one previous run is kept), so
  /// the current file still describes exactly one attempt.
  static Future<void> startRun(String label) async {
    try {
      final File file = await _file();
      try {
        if (await file.exists() && await file.length() > 0) {
          final File previous = await _previousFile();
          if (await previous.exists()) await previous.delete();
          await file.rename(previous.path);
        }
      } on Object {
        // Rotation is best-effort; the new run still starts below.
      }
      await file.writeAsString(
        '=== ${DateTime.now().toIso8601String()} run start: $label ===\n',
        mode: FileMode.write,
        flush: true,
      );
    } on Object {
      // Diagnostics must never take down real processing.
    }
  }

  static Future<void> log(String message) {
    final Future<void> next = _writeTail.then((_) async {
      try {
        final File file = await _file();
        final int? rssBytes = _currentRssBytes();
        final String memoryPart = rssBytes == null
            ? ''
            : ' rss=${(rssBytes / (1024 * 1024)).toStringAsFixed(0)}MB';
        await file.writeAsString(
          '${DateTime.now().toIso8601String()}$memoryPart $message\n',
          mode: FileMode.append,
          flush: true,
        );
      } on Object {
        // Best-effort only.
      }
    });
    _writeTail = next.catchError((Object _) {});
    return next;
  }

  /// Writes a high-frequency diagnostic event no more than once per [interval]
  /// for the same [key]. Normal stage/error diagnostics should keep using
  /// [log] so they are never suppressed.
  static Future<void> logRateLimited(
    String key,
    String message, {
    Duration interval = const Duration(seconds: 1),
  }) {
    final DateTime now = DateTime.now();
    final DateTime? last = _lastRateLimitedWrite[key];
    if (last != null && now.difference(last) < interval) {
      return Future<void>.value();
    }
    _lastRateLimitedWrite[key] = now;
    return log(message);
  }

  static int? _currentRssBytes() {
    try {
      return ProcessInfo.currentRss;
    } on Object {
      return null;
    }
  }

  /// Work363: copies the current (and, when present, previous) log into a
  /// share directory under timestamped names, for sharing as text files
  /// instead of pasting very long logs. Returns the copies (current first);
  /// empty when no log exists.
  static Future<List<File>> exportForSharing() async {
    final List<File> out = <File>[];
    try {
      await _writeTail;
      final Directory base = await getTemporaryDirectory();
      final Directory shareDir =
          Directory('${base.path}${Platform.pathSeparator}diagnostic_share');
      if (await shareDir.exists()) await shareDir.delete(recursive: true);
      await shareDir.create(recursive: true);
      final DateTime now = DateTime.now();
      String two(int v) => v.toString().padLeft(2, '0');
      final String stamp = '${now.year}${two(now.month)}${two(now.day)}_'
          '${two(now.hour)}${two(now.minute)}${two(now.second)}';
      final File current = await _file();
      if (await current.exists() && await current.length() > 0) {
        out.add(await current.copy(
          '${shareDir.path}${Platform.pathSeparator}'
          'mobile_stack_log_$stamp.txt',
        ));
      }
      final File previous = await _previousFile();
      if (await previous.exists() && await previous.length() > 0) {
        out.add(await previous.copy(
          '${shareDir.path}${Platform.pathSeparator}'
          'mobile_stack_log_${stamp}_previous_run.txt',
        ));
      }
    } on Object {
      // Callers report "no log" when nothing could be exported.
    }
    return out;
  }

  static Future<File?> existingLogFile() async {
    try {
      final File file = await _file();
      if (!await file.exists()) return null;
      return file;
    } on Object {
      return null;
    }
  }
}
