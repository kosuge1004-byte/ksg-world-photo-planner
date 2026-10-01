import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/export/dng_final_render_profile.dart';
import '../../core/image/file_backed_linear_rgb_tile_store.dart';
import '../../core/export/output_image_format.dart';
import '../../core/export/lightroom_storage_preset.dart';
import '../../core/meteor/meteor_composite_result.dart';
import '../../core/meteor/streak_compositor.dart'
    show MeteorRadiantEstimate, estimateMeteorRadiant;
import '../../core/meteor/streak_persistence_classifier.dart';
import '../../core/meteor/streak_shape.dart';
import '../../core/settings/app_settings.dart';
import '../../core/models/processing_mode.dart';
import '../../core/session/meteor_pipeline.dart';
import '../../design/mobile_stack_theme.dart';
import '../common/result_screen.dart';

/// Lets the user review every streak candidate `meteor_pipeline.dart`'s
/// `runMeteorAnalysisPipeline` found (Work60) and pick one to composite
/// into a final image via `meteor_composite_result.dart` (Work61-63),
/// closing meteor mode's own share of the "select RAWs -> get a viewable
/// image" loop that Work65 closed for star trail/Milky Way mode.
///
/// Deliberately list-based, not an interactive image overlay — meteor
/// mode's own design (`streak_candidate_detector.dart`'s doc comment)
/// is a human making the final call on an *ambiguous* signal a single
/// frame's pixel data cannot fully resolve on its own
/// (`StreakPersistenceCategory`'s four values are exactly this
/// ambiguity, made explicit rather than hidden), so this screen's job is
/// to present that ambiguity honestly — frame index, persistence
/// category, streak length, and the blinking signal for every candidate
/// — not to visually guess where a hypothetical "select the right
/// region of the photo" gesture should point, which would be a
/// substantially larger and riskier piece of interactive UI to write
/// without any way to render or test it here.
///
/// Owns [MeteorAnalysisResult.frameStores] for its own lifetime:
/// disposes every non-null entry in [dispose] (idempotent — see
/// `FileBackedLinearRgbTileStore.dispose`'s own `_isDisposed` guard —
/// so a store already disposed by a successful composite is a safe
/// no-op here, not a double-free).
///
/// This file has not been executed against the Dart SDK, nor rendered
/// on a device (unavailable in the environment that wrote it) — the
/// same visual-correctness caveat `result_screen.dart`'s own doc comment
/// states applies here too, and more so, given this screen has
/// materially more interactive state (selection) than that one's simple
/// static display.
class MeteorReviewScreen extends StatefulWidget {
  const MeteorReviewScreen({
    required this.result,
    this.outputFormat = OutputImageFormat.bmp8,
    this.renderProfile,
    this.storagePreset = LightroomStoragePreset.maximum,
    this.onBackgroundCompositeRequested,
    super.key,
  });

  final MeteorAnalysisResult result;
  final OutputImageFormat outputFormat;
  final DngFinalRenderProfile? renderProfile;
  final LightroomStoragePreset storagePreset;
  final Future<void> Function(List<int> selectedCandidateIndices)?
      onBackgroundCompositeRequested;

  @override
  State<MeteorReviewScreen> createState() => _MeteorReviewScreenState();
}

class _MeteorReviewScreenState extends State<MeteorReviewScreen> {
  final Set<int> _selectedCandidateIndices = <int>{};
  bool _compositing = false;
  // Work357: additive compositing preference (read by the background
  // composite launch) and shower-radiant consistency per candidate.
  bool _additiveComposite = AppSettings.defaultMeteorAdditiveComposite;
  late final List<bool> _radiantConsistent = _computeRadiantConsistency();

  List<bool> _computeRadiantConsistency() {
    final List<MeteorCandidate> candidates = widget.result.candidates;
    // O(n^3); the candidate list is user-reviewed and normally short.
    if (candidates.length < 3 || candidates.length > 200) {
      return List<bool>.filled(candidates.length, false);
    }
    final MeteorRadiantEstimate estimate = estimateMeteorRadiant(<StreakShape>[
      for (final MeteorCandidate c in candidates) c.streak,
    ]);
    return estimate.consistent;
  }

  @override
  void initState() {
    super.initState();
    AppSettings.loadMeteorAdditiveComposite().then((bool value) {
      if (mounted) setState(() => _additiveComposite = value);
    });
  }
  bool _framesDisposed = false;

  @override
  void dispose() {
    _disposeFrameStoresIfNeeded();
    super.dispose();
  }

  void _disposeFrameStoresIfNeeded() {
    if (_framesDisposed) return;
    _framesDisposed = true;
    for (final store in widget.result.frameStores) {
      if (store != null) unawaited(store.dispose());
    }
  }

  Future<void> _releaseFrameStoresForBackground() async {
    if (_framesDisposed) return;
    for (final store in widget.result.frameStores) {
      if (store == null) continue;
      if (store is! FileBackedLinearRgbTileStore) {
        throw StateError('バックグラウンド流星合成には永続RGBストアが必要です。');
      }
      await store.closeRetainingFile();
    }
    _framesDisposed = true;
  }

  Future<void> _compositeSelected() async {
    if (_selectedCandidateIndices.isEmpty) return;
    final List<int> selectedIndices = _selectedCandidateIndices.toList()
      ..sort();
    final Future<void> Function(List<int>)? backgroundRequest =
        widget.onBackgroundCompositeRequested;
    if (Platform.isAndroid && backgroundRequest != null) {
      setState(() => _compositing = true);
      try {
        await backgroundRequest(selectedIndices);
        await _releaseFrameStoresForBackground();
        if (mounted) Navigator.of(context).pop();
      } catch (error) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('バックグラウンド合成を開始できませんでした: $error')),
        );
        setState(() => _compositing = false);
      }
      return;
    }
    final List<MeteorCandidate> candidates = <MeteorCandidate>[
      for (final int index in selectedIndices) widget.result.candidates[index],
    ];
    final Set<int> foregroundFrameIndices = candidates
        .map((MeteorCandidate candidate) => candidate.frameIndex)
        .toSet();

    setState(() => _compositing = true);
    Directory? outputDirectory;
    bool resultHandedToScreen = false;
    try {
      outputDirectory =
          await Directory.systemTemp.createTemp('mobile-stack-meteor-result-');
      final String outputPath = '${outputDirectory.path}'
          '${Platform.pathSeparator}result.${widget.outputFormat.extension}';
      List<int> backgroundIndices =
          defaultBackgroundFrameIndicesForSelectedFrames(
        widget.result,
        foregroundFrameIndices,
      );
      if (backgroundIndices.isEmpty) {
        backgroundIndices = defaultBackgroundFrameIndicesForSelectedFrames(
          widget.result,
          foregroundFrameIndices,
          excludeFrameIndicesWithCandidates: false,
        );
      }
      if (backgroundIndices.isEmpty) {
        throw StateError('選択した流星を含まない背景フレームがありません。背景用の写真を追加してください。');
      }
      final File resultFile =
          await compositeSelectedMeteorStreaksTiledAndExport(
        frameStores: widget.result.frameStores,
        selectedStreaks: <SelectedMeteorStreak>[
          for (final MeteorCandidate candidate in candidates)
            SelectedMeteorStreak(
              frameIndex: candidate.frameIndex,
              streak: candidate.streak,
            ),
        ],
        backgroundFrameIndices: backgroundIndices,
        intermediateTileStoreFactory:
            FileBackedLinearRgbTileStore.createTemporary,
        exportPath: outputPath,
        outputFormat: widget.outputFormat,
        linearDngCompression: widget.storagePreset.dngCompression,
        renderProfile: widget.renderProfile,
      );
      if (!mounted) return;
      // 合成が完了したら、このフレームストア群はもう不要になる
      // (composite関数の内部では破棄されないため、ここで明示的に
      // 破棄する -- MeteorAnalysisResult.frameStoresの所有権は
      // この画面にある、というWork60の設計どおり)。
      _disposeFrameStoresIfNeeded();
      resultHandedToScreen = true;
      await Navigator.of(context).pushReplacement<void, void>(
        MaterialPageRoute<void>(
          builder: (_) => ResultScreen(
            mode: ProcessingMode.meteor,
            imageFile: resultFile,
            frameCount: widget.result.frameDiagnostics.length,
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('合成に失敗しました: $error')),
      );
    } finally {
      if (!resultHandedToScreen && outputDirectory != null) {
        try {
          if (await outputDirectory.exists()) {
            await outputDirectory.delete(recursive: true);
          }
        } on FileSystemException {
          // Best-effort cleanup after a failed/cancelled composite.
        }
      }
      if (mounted) setState(() => _compositing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final List<MeteorCandidate> candidates = widget.result.candidates;

    return Scaffold(
      appBar: AppBar(title: const Text('流星候補を選択')),
      body: StarfieldBackground(
        child: SafeArea(
          child: candidates.isEmpty
              ? const _NoCandidatesFound()
              : Column(
                  children: <Widget>[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                      child: Text(
                        '${candidates.length}件の候補が見つかりました。'
                        '合成したい候補を複数選べます。',
                        style: const TextStyle(color: MobileStackColors.muted),
                      ),
                    ),
                    Expanded(
                      child: ListView.separated(
                        padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
                        itemCount: candidates.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (BuildContext context, int index) {
                          return _CandidateCard(
                            candidate: candidates[index],
                            radiantConsistent: _radiantConsistent[index],
                            selected: _selectedCandidateIndices.contains(index),
                            onTap: _compositing
                                ? null
                                : () => setState(() {
                                      if (!_selectedCandidateIndices
                                          .add(index)) {
                                        _selectedCandidateIndices.remove(index);
                                      }
                                    }),
                          );
                        },
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 0, 12, 0),
                      child: SwitchListTile.adaptive(
                        value: _additiveComposite,
                        title: const Text('流れ星を背景になじませて合成'),
                        subtitle: const Text(
                          '流れ星の光だけを背景に足し込み、周囲の1枚分のざらつきや縁の段差を出さないようにします（バックグラウンド合成で有効）。',
                          style: TextStyle(color: MobileStackColors.muted),
                        ),
                        onChanged: _compositing
                            ? null
                            : (bool value) {
                                setState(() => _additiveComposite = value);
                                AppSettings.saveMeteorAdditiveComposite(value);
                              },
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                      child: FilledButton(
                        onPressed:
                            _selectedCandidateIndices.isEmpty || _compositing
                                ? null
                                : _compositeSelected,
                        child: Text(
                          _compositing
                              ? '合成中…'
                              : '${_selectedCandidateIndices.length}件を合成する',
                        ),
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _CandidateCard extends StatelessWidget {
  const _CandidateCard({
    required this.candidate,
    required this.selected,
    required this.onTap,
    this.radiantConsistent = false,
  });

  final MeteorCandidate candidate;
  final bool radiantConsistent;
  final bool selected;
  final VoidCallback? onTap;

  String get _categoryLabel => switch (candidate.persistence.category) {
        StreakPersistenceCategory.isolated => '単独フレーム(流星の可能性が高い)',
        StreakPersistenceCategory.independentMotion => '独立した動き(人工衛星・飛行機の可能性)',
        StreakPersistenceCategory.skyMotion => '星の動きと一致(星の軌跡の可能性が高い)',
        StreakPersistenceCategory.linkedTransformUnavailable => '判定材料不足',
      };

  Color get _categoryColor => switch (candidate.persistence.category) {
        StreakPersistenceCategory.isolated => MobileStackColors.success,
        StreakPersistenceCategory.independentMotion => MobileStackColors.accent,
        StreakPersistenceCategory.skyMotion => MobileStackColors.muted,
        StreakPersistenceCategory.linkedTransformUnavailable =>
          MobileStackColors.muted,
      };

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(14),
          color: selected
              ? MobileStackColors.accent.withValues(alpha: 0.14)
              : const Color(0xFF1B2231),
          border: Border.all(
            color:
                selected ? MobileStackColors.accent : const Color(0xFF29313F),
          ),
        ),
        child: Row(
          children: <Widget>[
            Icon(
              selected ? Icons.check_circle : Icons.circle_outlined,
              color:
                  selected ? MobileStackColors.accent : MobileStackColors.muted,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    'フレーム ${candidate.frameIndex + 1}',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    _categoryLabel,
                    style: TextStyle(color: _categoryColor, fontSize: 12),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '長さ: ${candidate.streak.length.toStringAsFixed(0)}px'
                    '${candidate.brightnessProfile.likelyBlinking ? " ・ 点滅あり" : ""}'
                    '${radiantConsistent ? " ・ 放射点と整合" : ""}',
                    style: const TextStyle(
                      color: MobileStackColors.muted,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _NoCandidatesFound extends StatelessWidget {
  const _NoCandidatesFound();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(
              Icons.search_off_rounded,
              size: 48,
              color: MobileStackColors.muted,
            ),
            SizedBox(height: 12),
            Text(
              '流星痕候補は見つかりませんでした',
              textAlign: TextAlign.center,
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
          ],
        ),
      ),
    );
  }
}
