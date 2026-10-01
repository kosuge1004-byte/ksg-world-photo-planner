import 'package:crypto/crypto.dart';
import 'dart:convert';
import 'dart:io';

import '../meteor/streak_candidate_detector.dart';
import '../registration/star_detector.dart';

/// Durable, resumable checkpoint for the first pass of meteor candidate
/// analysis: per-frame streak detection (`_detectContinuousAndBeadedStreaks`)
/// and star detection (`detectStars`) inside `analyzeDecodedFrames`.
///
/// Decode is already durable (`restoreDecodedFrame`/`onDecodedFrameCommitted`
/// in `runMeteorAnalysisPipeline`), but the detection pass that runs once
/// decode finishes previously kept its results (`diagnostics`,
/// `streaksByFrame`, `starsByFrame`) only in memory for the lifetime of one
/// `analyzeDecodedFrames` call. A process death partway through a long
/// sequence (hundreds of frames, one full-resolution green-channel detection
/// pass each) discarded every already-analyzed frame's results even though
/// every decoded frame was still cached on disk, and restarted this whole
/// pass from frame zero.
///
/// This store changes no detection algorithm. `StreakCandidate` and
/// `DetectedStar` are both plain immutable value types (see their
/// definitions), so this module serializes and reconstructs them field for
/// field rather than reinterpreting or approximating anything.
///
/// [identity] is an opaque string the caller must derive from everything
/// that affects detection results byte-for-byte for a given frame: which
/// decoded frame this is (its own content identity), and the streak/star
/// detector thresholds and algorithm revision. A manifest whose stored
/// identity does not match is never partially trusted — it is discarded
/// wholesale, exactly like `FocusStackStageCheckpointStore`, since detection
/// results computed under different thresholds must never be silently
/// reused as if they were computed under the current ones.
final class MeteorCandidateAnalysisCheckpointStore {
  MeteorCandidateAnalysisCheckpointStore({
    required this.directory,
    required this.identity,
  });

  static const int _version = 2;
  final Directory directory;
  final String identity;

  String get _manifestPath =>
      '${directory.path}${Platform.pathSeparator}meteor_candidate_checkpoint_v1.json';

  Map<String, dynamic>? _manifest;

  Future<Map<String, dynamic>> _ensureLoaded() async {
    final Map<String, dynamic>? loaded = _manifest;
    if (loaded != null) return loaded;
    final File file = File(_manifestPath);
    Map<String, dynamic>? matched;
    try {
      if (await file.exists()) {
        final Object? decoded = jsonDecode(await file.readAsString());
        if (decoded is Map &&
            decoded['version'] == _version &&
            decoded['identity'] == identity && decoded['integritySha256'] == _manifestHash(decoded)) {
          matched = decoded.cast<String, dynamic>();
        }
      }
    } on Object {
      matched = null;
    }
    if (matched != null) {
      return _manifest = matched;
    }
    // No manifest, an unreadable one, or one for a different identity: any
    // of these means nothing already recorded here can be trusted for the
    // current run, so start over rather than mix generations.
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
    await directory.create(recursive: true);
    return _manifest = <String, dynamic>{
      'version': _version,
      'identity': identity,
      'frames': <String, dynamic>{},
    };
  }

  static String _manifestHash(Map value) => sha256.convert(utf8.encode(jsonEncode({
    for(final entry in value.entries) if(entry.key!='integritySha256') entry.key:entry.value,
  }))).toString();

  Future<void> _persist() async {
    final Map<String, dynamic> manifest = _manifest!;
    await directory.create(recursive: true);
    final File destination = File(_manifestPath);
    final File temp = File(
      '$_manifestPath.tmp.${pid.toString()}.${DateTime.now().microsecondsSinceEpoch}',
    );
    manifest['integritySha256'] = _manifestHash(manifest);
    await temp.writeAsString(jsonEncode(manifest), flush: true);
    await temp.rename(destination.path);
  }

  /// The recorded detection result for frame [index], or null if nothing
  /// (valid) is recorded. `analyzed: false` is itself a valid, recordable
  /// outcome (the frame failed to decode), distinct from "not yet analyzed".
  Future<MeteorCandidateCheckpointFrame?> restoreFrame(int index) async {
    final Map<String, dynamic> manifest = await _ensureLoaded();
    final Map<String, dynamic> frames =
        (manifest['frames'] as Map).cast<String, dynamic>();
    final Map<String, dynamic>? entry =
        (frames['$index'] as Map?)?.cast<String, dynamic>();
    if (entry == null) return null;
    try {
      final bool analyzed = entry['analyzed'] as bool;
      if (!analyzed) {
        return MeteorCandidateCheckpointFrame(
          analyzed: false,
          excludedReason: entry['excludedReason'] as String?,
          streaks: const <StreakCandidate>[],
          stars: const <DetectedStar>[],
        );
      }
      final List<dynamic> streakEntries = entry['streaks'] as List<dynamic>;
      final List<dynamic> starEntries = entry['stars'] as List<dynamic>;
      return MeteorCandidateCheckpointFrame(
        analyzed: true,
        excludedReason: null,
        streaks: <StreakCandidate>[
          for (final dynamic raw in streakEntries)
            _decodeStreak((raw as Map).cast<String, dynamic>()),
        ],
        stars: <DetectedStar>[
          for (final dynamic raw in starEntries)
            _decodeStar((raw as Map).cast<String, dynamic>()),
        ],
      );
    } on Object {
      // A corrupt/truncated entry for this one frame must not take down the
      // rest of the checkpoint or the run; the caller simply re-detects it.
      return null;
    }
  }

  Future<void> recordFrame(
    int index,
    MeteorCandidateCheckpointFrame frame,
  ) async {
    final Map<String, dynamic> manifest = await _ensureLoaded();
    final Map<String, dynamic> frames =
        (manifest['frames'] as Map).cast<String, dynamic>();
    frames['$index'] = frame.analyzed
        ? <String, dynamic>{
            'analyzed': true,
            'streaks': <Map<String, dynamic>>[
              for (final StreakCandidate streak in frame.streaks)
                _encodeStreak(streak),
            ],
            'stars': <Map<String, dynamic>>[
              for (final DetectedStar star in frame.stars) _encodeStar(star),
            ],
          }
        : <String, dynamic>{
            'analyzed': false,
            if (frame.excludedReason != null)
              'excludedReason': frame.excludedReason,
          };
    manifest['frames'] = frames;
    await _persist();
  }

  /// Discards this checkpoint's manifest and directory. Callers invoke this
  /// once `analyzeDecodedFrames` has returned its final result for the run
  /// this checkpoint was for, or when deliberately starting over (e.g. the
  /// user changed a detection threshold).
  Future<void> clear() async {
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
    _manifest = null;
  }

  static Map<String, dynamic> _encodeStreak(StreakCandidate streak) =>
      <String, dynamic>{
        'centroidX': streak.centroidX,
        'centroidY': streak.centroidY,
        'angleRadians': streak.angleRadians,
        'length': streak.length,
        'width': streak.width,
        'elongation': streak.elongation,
        'flux': streak.flux,
        'pixelCount': streak.pixelCount,
        'endpoints': <List<double>>[
          for (final ({double x, double y}) point in streak.endpoints)
            <double>[point.x, point.y],
        ],
      };

  static StreakCandidate _decodeStreak(Map<String, dynamic> m) =>
      StreakCandidate(
        centroidX: (m['centroidX'] as num).toDouble(),
        centroidY: (m['centroidY'] as num).toDouble(),
        angleRadians: (m['angleRadians'] as num).toDouble(),
        length: (m['length'] as num).toDouble(),
        width: (m['width'] as num).toDouble(),
        elongation: (m['elongation'] as num).toDouble(),
        flux: (m['flux'] as num).toDouble(),
        pixelCount: (m['pixelCount'] as num).toInt(),
        endpoints: <({double x, double y})>[
          for (final dynamic raw in m['endpoints'] as List<dynamic>)
            (
              x: ((raw as List<dynamic>)[0] as num).toDouble(),
              y: (raw[1] as num).toDouble(),
            ),
        ],
      );

  static Map<String, dynamic> _encodeStar(DetectedStar star) =>
      <String, dynamic>{
        'x': star.x,
        'y': star.y,
        'flux': star.flux,
        'peakValue': star.peakValue,
        'roundness': star.roundness,
        'sharpness': star.sharpness,
        if (star.psfFwhmPx != null) 'psfFwhmPx': star.psfFwhmPx,
      };

  static DetectedStar _decodeStar(Map<String, dynamic> m) => DetectedStar(
        x: (m['x'] as num).toDouble(),
        y: (m['y'] as num).toDouble(),
        flux: (m['flux'] as num).toDouble(),
        peakValue: (m['peakValue'] as num).toDouble(),
        roundness: (m['roundness'] as num).toDouble(),
        sharpness: (m['sharpness'] as num).toDouble(),
        psfFwhmPx: (m['psfFwhmPx'] as num?)?.toDouble(),
      );
}

/// One frame's restored or about-to-be-recorded detection result.
final class MeteorCandidateCheckpointFrame {
  const MeteorCandidateCheckpointFrame({
    required this.analyzed,
    required this.excludedReason,
    required this.streaks,
    required this.stars,
  });

  final bool analyzed;
  final String? excludedReason;
  final List<StreakCandidate> streaks;
  final List<DetectedStar> stars;
}
