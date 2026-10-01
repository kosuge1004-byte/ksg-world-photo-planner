import 'dart:convert';
import 'dart:io';

/// Persists, across `:processor` restarts of *the same job*, how many
/// consecutive attempts have hit
/// `AdaptiveResourceState.critical` (see `adaptive_resource_controller.dart`)
/// so the next attempt can start more conservative instead of blindly
/// retrying with identical settings and hoping.
///
/// This is deliberately tiny and dumb on purpose: one JSON object, one
/// counter, one cause string. It only ever adjusts `tileSize` — a
/// storage/memory-layout parameter that changes zero output bytes (tiles
/// are combined losslessly) — never resolution, precision, or stacking
/// weights. See `CODEX_START_HERE.txt`'s quality constraints.
///
/// The counter resets to zero the moment a job attempt completes without
/// ever hitting critical pressure, so a device that was briefly under
/// heavy load (another app, a phone call) doesn't stay artificially
/// throttled forever once conditions genuinely improve.
final class CompletionAttemptHistory {
  const CompletionAttemptHistory({
    required this.consecutiveCriticalAttempts,
    required this.lastCause,
  });

  factory CompletionAttemptHistory.empty() => const CompletionAttemptHistory(
        consecutiveCriticalAttempts: 0,
        lastCause: null,
      );

  final int consecutiveCriticalAttempts;
  final String? lastCause;

  Map<String, Object?> toJson() => <String, Object?>{
        'consecutiveCriticalAttempts': consecutiveCriticalAttempts,
        'lastCause': lastCause,
      };

  static CompletionAttemptHistory fromJson(Map<String, Object?> json) {
    return CompletionAttemptHistory(
      consecutiveCriticalAttempts:
          (json['consecutiveCriticalAttempts'] as num?)?.toInt() ?? 0,
      lastCause: json['lastCause'] as String?,
    );
  }
}

/// Reads/writes a [CompletionAttemptHistory] at `$jobStatusPath.attempts`
/// and turns it into a concrete tile-size ceiling for the next attempt.
final class CompletionAttemptHistoryStore {
  const CompletionAttemptHistoryStore({required this.historyPath});

  final String historyPath;

  /// Smallest tile size this ladder will ever recommend. Below this,
  /// per-tile overhead stops helping and only adds CPU time without a
  /// meaningful memory-peak reduction, so escalating further wouldn't
  /// change the outcome — at that point the honest answer is "this
  /// device cannot fit this job", not "try an even smaller number".
  static const int minimumTileSize = 128;

  Future<CompletionAttemptHistory> load() async {
    try {
      final File file = File(historyPath);
      if (!await file.exists()) return CompletionAttemptHistory.empty();
      final Object? decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map<String, Object?>) {
        return CompletionAttemptHistory.empty();
      }
      return CompletionAttemptHistory.fromJson(decoded);
    } on Object {
      // A corrupt/unreadable history file should never block the job
      // itself from running — fall back to "no history", i.e. full
      // tile size, exactly as if this were the first attempt.
      return CompletionAttemptHistory.empty();
    }
  }

  Future<void> recordCriticalPressureHit({required String cause}) async {
    final CompletionAttemptHistory current = await load();
    final CompletionAttemptHistory next = CompletionAttemptHistory(
      consecutiveCriticalAttempts: current.consecutiveCriticalAttempts + 1,
      lastCause: cause,
    );
    await _write(next);
  }

  Future<void> recordCleanAttempt() async {
    final CompletionAttemptHistory current = await load();
    if (current.consecutiveCriticalAttempts == 0) return;
    await _write(CompletionAttemptHistory.empty());
  }

  Future<void> _write(CompletionAttemptHistory history) async {
    try {
      await File(historyPath).writeAsString(jsonEncode(history.toJson()));
    } on Object {
      // Best-effort: worst case, the next attempt starts from scratch
      // instead of already-throttled. Never let this fail the job.
    }
  }

  /// Halves [baseTileSize] once per consecutive critical-pressure
  /// attempt (floor: [minimumTileSize]), so a job that has already
  /// struggled twice in a row starts its third attempt noticeably more
  /// conservative rather than repeating the same losing configuration.
  static int recommendedTileSizeCeiling({
    required int baseTileSize,
    required int consecutiveCriticalAttempts,
  }) {
    int tileSize = baseTileSize;
    for (int step = 0; step < consecutiveCriticalAttempts; step++) {
      final int halved = tileSize ~/ 2;
      if (halved < minimumTileSize) break;
      tileSize = halved;
    }
    return tileSize.clamp(minimumTileSize, baseTileSize);
  }
}
