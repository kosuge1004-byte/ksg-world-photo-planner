import 'dart:convert';
import 'dart:io';

import '../image/file_backed_linear_rgb_tile_store.dart';
import '../image/linear_rgb_tile_store.dart';
import '../meteor/streak_brightness_profile.dart';
import '../meteor/streak_candidate_detector.dart';
import '../meteor/streak_persistence_classifier.dart';
import '../session/meteor_pipeline.dart';

Map<String, dynamic> _point(({double x, double y}) p) =>
    <String, dynamic>{'x': p.x, 'y': p.y};
({double x, double y}) _decodePoint(Object? raw) {
  final Map<String, dynamic> m = (raw as Map).cast<String, dynamic>();
  return (x: (m['x'] as num).toDouble(), y: (m['y'] as num).toDouble());
}

Map<String, dynamic> encodeMeteorAnalysisResult(MeteorAnalysisResult result) {
  return <String, dynamic>{
    'candidates': <Map<String, dynamic>>[
      for (final MeteorCandidate c in result.candidates)
        <String, dynamic>{
          'persistence': <String, dynamic>{
            'frameIndex': c.persistence.frameIndex,
            'persistentAcrossFrames': c.persistence.persistentAcrossFrames,
            'linkedFrameIndices': c.persistence.linkedFrameIndices,
            'skyConsistentFrameIndices':
                c.persistence.skyConsistentFrameIndices,
            'independentMotionFrameIndices':
                c.persistence.independentMotionFrameIndices,
            'category': c.persistence.category.name,
            'streak': _encodeStreak(c.streak),
          },
          'brightness': <String, dynamic>{
            'profile': c.brightnessProfile.profile,
            'positions': <Map<String, dynamic>>[
              for (final p in c.brightnessProfile.positions) _point(p),
            ],
            'segments': <Map<String, dynamic>>[
              for (final segment in c.brightnessProfile.segments)
                <String, dynamic>{
                  'startFraction': segment.startFraction,
                  'endFraction': segment.endFraction,
                },
            ],
            'segmentCount': c.brightnessProfile.segmentCount,
            'likelyBlinking': c.brightnessProfile.likelyBlinking,
            'longestGapFraction': c.brightnessProfile.longestGapFraction,
            'sufficientSamples': c.brightnessProfile.sufficientSamples,
          },
        },
    ],
    'frameDiagnostics': <Map<String, dynamic>>[
      for (final MeteorFrameDiagnostics d in result.frameDiagnostics)
        <String, dynamic>{
          'sourcePath': d.sourcePath,
          'analyzed': d.analyzed,
          'excludedReason': d.excludedReason,
          'detectedStarCount': d.detectedStarCount,
          'detectedStreakCount': d.detectedStreakCount,
        },
    ],
    'stores': <Map<String, dynamic>?>[
      for (final LinearRgbTileStore? store in result.frameStores)
        if (store == null)
          null
        else
          <String, dynamic>{
            'path': (store as FileBackedLinearRgbTileStore).path,
            'width': store.width,
            'height': store.height,
          },
    ],
  };
}

Map<String, dynamic> _encodeStreak(StreakCandidate s) => <String, dynamic>{
      'centroidX': s.centroidX,
      'centroidY': s.centroidY,
      'angleRadians': s.angleRadians,
      'length': s.length,
      'width': s.width,
      'elongation': s.elongation,
      'flux': s.flux,
      'pixelCount': s.pixelCount,
      'endpoints': <Map<String, dynamic>>[
        for (final p in s.endpoints) _point(p)
      ],
    };

StreakCandidate _decodeStreak(Map<String, dynamic> m) => StreakCandidate(
      centroidX: (m['centroidX'] as num).toDouble(),
      centroidY: (m['centroidY'] as num).toDouble(),
      angleRadians: (m['angleRadians'] as num).toDouble(),
      length: (m['length'] as num).toDouble(),
      width: (m['width'] as num).toDouble(),
      elongation: (m['elongation'] as num).toDouble(),
      flux: (m['flux'] as num).toDouble(),
      pixelCount: (m['pixelCount'] as num).toInt(),
      endpoints: <({double x, double y})>[
        for (final raw in (m['endpoints'] as List<dynamic>)) _decodePoint(raw),
      ],
    );

BrightnessSegment _decodeBrightnessSegment(Object? raw) {
  final Map<String, dynamic> m = (raw as Map).cast<String, dynamic>();
  return BrightnessSegment(
    startFraction: (m['startFraction'] as num).toDouble(),
    endFraction: (m['endFraction'] as num).toDouble(),
  );
}

MeteorFrameDiagnostics _decodeDiagnostics(Object? raw) {
  final Map<String, dynamic> m = (raw as Map).cast<String, dynamic>();
  return MeteorFrameDiagnostics(
    sourcePath: m['sourcePath'] as String,
    analyzed: m['analyzed'] as bool,
    excludedReason: m['excludedReason'] as String?,
    detectedStarCount: (m['detectedStarCount'] as num?)?.toInt(),
    detectedStreakCount: (m['detectedStreakCount'] as num?)?.toInt(),
  );
}

Future<MeteorAnalysisResult> readMeteorAnalysisResult(String path) async {
  final Object? decoded = jsonDecode(await File(path).readAsString());
  if (decoded is! Map<String, dynamic>) {
    throw StateError('Invalid meteor analysis file.');
  }
  final List<LinearRgbTileStore?> stores = <LinearRgbTileStore?>[];
  for (final Object? raw in decoded['stores'] as List<dynamic>) {
    if (raw == null) {
      stores.add(null);
      continue;
    }
    final Map<String, dynamic> m = (raw as Map).cast<String, dynamic>();
    stores.add(await FileBackedLinearRgbTileStore.openCommitted(
      path: m['path'] as String,
      width: (m['width'] as num).toInt(),
      height: (m['height'] as num).toInt(),
    ));
  }
  final List<MeteorCandidate> candidates = <MeteorCandidate>[];
  for (final Object? raw in decoded['candidates'] as List<dynamic>) {
    final Map<String, dynamic> m = (raw as Map).cast<String, dynamic>();
    final Map<String, dynamic> p =
        (m['persistence'] as Map).cast<String, dynamic>();
    final Map<String, dynamic> b =
        (m['brightness'] as Map).cast<String, dynamic>();
    final StreakCandidate streak =
        _decodeStreak((p['streak'] as Map).cast<String, dynamic>());
    candidates.add(MeteorCandidate(
      persistence: StreakPersistenceResult(
        frameIndex: (p['frameIndex'] as num).toInt(),
        streak: streak,
        persistentAcrossFrames: p['persistentAcrossFrames'] as bool,
        linkedFrameIndices: (p['linkedFrameIndices'] as List<dynamic>)
            .cast<num>()
            .map((n) => n.toInt())
            .toList(),
        skyConsistentFrameIndices:
            (p['skyConsistentFrameIndices'] as List<dynamic>)
                .cast<num>()
                .map((n) => n.toInt())
                .toList(),
        independentMotionFrameIndices:
            (p['independentMotionFrameIndices'] as List<dynamic>)
                .cast<num>()
                .map((n) => n.toInt())
                .toList(),
        category: StreakPersistenceCategory.values
            .firstWhere((v) => v.name == p['category']),
      ),
      brightnessProfile: StreakBrightnessProfile(
        profile: (b['profile'] as List<dynamic>)
            .cast<num>()
            .map((n) => n.toDouble())
            .toList(),
        positions: <({double x, double y})>[
          for (final rawPoint in b['positions'] as List<dynamic>)
            _decodePoint(rawPoint),
        ],
        segments: <BrightnessSegment>[
          for (final rawSegment in b['segments'] as List<dynamic>)
            _decodeBrightnessSegment(rawSegment),
        ],
        segmentCount: (b['segmentCount'] as num).toInt(),
        likelyBlinking: b['likelyBlinking'] as bool,
        longestGapFraction: (b['longestGapFraction'] as num).toDouble(),
        sufficientSamples: b['sufficientSamples'] as bool,
      ),
    ));
  }
  final List<MeteorFrameDiagnostics> diagnostics = <MeteorFrameDiagnostics>[
    for (final Object? raw in decoded['frameDiagnostics'] as List<dynamic>)
      _decodeDiagnostics(raw),
  ];
  return MeteorAnalysisResult(
    candidates: candidates,
    frameDiagnostics: diagnostics,
    frameStores: stores,
  );
}
