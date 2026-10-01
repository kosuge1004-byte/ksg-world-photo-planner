import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/io/file_picker_raw_input_reader.dart';
import '../../core/io/raw_input_contract.dart';
import '../../core/export/output_image_format.dart';
import '../../core/export/lightroom_storage_preset.dart';
import '../../core/quality/processing_quality_level.dart';
import '../../core/models/processing_mode.dart';
import '../../core/raw/native_raw_decoder_factory.dart';
import '../../core/raw/raw_format.dart';
import '../../core/session/processing_session.dart';
import '../../core/settings/app_settings.dart';
import '../../core/stacking/star_trail_edge_fade.dart';
import '../../core/stacking/star_trail_gap_fill.dart';
import '../../design/mobile_stack_theme.dart';
import 'processing_progress_screen.dart';
import 'standard_background_progress_screen.dart';
import 'reference_photo_selection_screen.dart';
import 'stack_settings_screen.dart';

class RawSelectionScreen extends StatefulWidget {
  const RawSelectionScreen({
    required this.mode,
    required this.description,
    this.progressScreenBuilder,
    this.requireReferenceSelection = true,
    this.enableMovingObjectRemovalSetting = true,
    super.key,
  });

  final ProcessingMode mode;
  final String description;

  /// 遷移先の進捗画面を差し替えるための任意のビルダー。`null`(既定値)
  /// の場合は、これまで通り[ProcessingProgressScreen]へ遷移する。
  /// 既存の呼び出し元(StarTrailScreen・MilkyWayScreen・MeteorScreen)は
  /// この引数を渡していないため、挙動は一切変わらない。CFA drizzle
  /// ベースの実験的パイプライン(`cfa_drizzle_milky_way_progress_
  /// screen.dart`)など、通常のパイプラインとは別の遷移先を必要とする
  /// 新しい呼び出し元のために追加した。
  final Widget Function(ProcessingSession session)? progressScreenBuilder;

  /// Experimental pipelines that do not consume the normal stack reference
  /// can opt out instead of presenting a UI-only selection.
  final bool requireReferenceSelection;

  /// Only the normal Milky Way pipeline consumes this toggle. Experimental
  /// pipelines can explicitly hide it.
  final bool enableMovingObjectRemovalSetting;

  @override
  State<RawSelectionScreen> createState() => _RawSelectionScreenState();
}

class _RawSelectionScreenState extends State<RawSelectionScreen> {
  late final ProcessingSession _session;
  final FilePickerRawInputReader _reader = FilePickerRawInputReader(
    metadataProbe: createProductionNativeRawMetadataProbe(),
  );
  bool _isPicking = false;

  @override
  void initState() {
    super.initState();
    _session = ProcessingSession(mode: widget.mode)
      ..addListener(_onSessionChanged);
    _loadDefaults();
  }

  Future<void> _loadDefaults() async {
    try {
      final values = await Future.wait<Object>(<Future<Object>>[
        AppSettings.loadOutputFormat(),
        AppSettings.loadQualityLevel(),
        AppSettings.loadStoragePreset(),
        AppSettings.loadAutomaticMovingObjectRemoval(),
        AppSettings.loadAutomaticStarTrailAircraftRemoval(),
        AppSettings.loadAutomaticStarTrailForegroundProtection(),
        AppSettings.loadStarTrailGapFillMode(),
        AppSettings.loadStarTrailFadeMode(),
        AppSettings.loadStarTrailFadeCurve(),
        AppSettings.loadStarTrailFadeLengthFraction(),
        AppSettings.loadStarTrailFadeMinWeight(),
        AppSettings.loadWholeFieldRegistration(),
        AppSettings.loadStarTrailHotPixelRemoval(),
        AppSettings.loadStarTrailMeteorProtection(),
        AppSettings.loadStarTrailMeanBackground(),
        AppSettings.loadStarTrailForegroundAverage(),
      ]);
      if (!mounted || _session.status == SessionStatus.processing) return;
      _session
        ..setOutputFormat(values[0] as OutputImageFormat)
        ..setQualityLevel(values[1] as ProcessingQualityLevel)
        ..setStoragePreset(values[2] as LightroomStoragePreset)
        ..setAutomaticMovingObjectRemoval(values[3] as bool)
        ..setAutomaticStarTrailAircraftRemoval(values[4] as bool)
        ..setAutomaticStarTrailForegroundProtection(values[5] as bool)
        ..setStarTrailGapFillMode(values[6] as StarTrailGapFillMode)
        ..setStarTrailFadeMode(values[7] as StarTrailFadeMode)
        ..setStarTrailFadeCurve(values[8] as StarTrailFadeCurve)
        ..setStarTrailFadeLengthFraction(values[9] as double)
        ..setStarTrailFadeMinWeight(values[10] as double)
        ..setWholeFieldRegistration(values[11] as bool)
        ..setStarTrailHotPixelRemoval(values[12] as bool)
        ..setStarTrailMeteorProtection(values[13] as bool)
        ..setStarTrailMeanBackground(values[14] as bool)
        ..setStarTrailForegroundAverage(values[15] as bool);
    } on StateError {
      // Widget tests and unsupported desktop embedders may not register the
      // preferences platform. Keep the safe in-memory default in that case.
    }
  }

  @override
  void dispose() {
    _session
      ..removeListener(_onSessionChanged)
      ..dispose();
    super.dispose();
  }

  void _onSessionChanged() {
    if (mounted) setState(() {});
  }

  Future<void> _selectFiles() async {
    if (_isPicking) return;
    setState(() => _isPicking = true);
    try {
      final RawSelectionResult selection = await _reader.selectRawFiles();
      _session.addFiles(selection.files);
      if (!mounted || selection.rejected.isEmpty) return;

      final RawInputRejection first = selection.rejected.first;
      final String prefix = selection.rejected.length == 1
          ? first.name
          : '${selection.rejected.length}件';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('$prefixを追加できませんでした：${first.reason}'),
          duration: const Duration(seconds: 5),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('RAWファイルを読み込めませんでした：$error')));
    } finally {
      if (mounted) setState(() => _isPicking = false);
    }
  }

  Future<void> _startProcessing() async {
    if (!_session.canStart) return;
    if (widget.requireReferenceSelection &&
        (widget.mode == ProcessingMode.milkyWay ||
            widget.mode == ProcessingMode.starTrail)) {
      final String? referencePath = await Navigator.of(context).push<String>(
        MaterialPageRoute<String>(
          builder: (_) => ReferencePhotoSelectionScreen(
            files: _session.files,
            mode: widget.mode,
            initialReferencePath: _session.referencePath,
          ),
        ),
      );
      if (!mounted || referencePath == null) return;
      _session.setReferencePath(referencePath);
    }

    final bool? settingsAccepted = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => StackSettingsScreen(
          session: _session,
          showMovingObjectRemoval: widget.enableMovingObjectRemovalSetting,
        ),
      ),
    );
    if (!mounted || settingsAccepted != true) return;

    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) =>
            widget.progressScreenBuilder?.call(_session) ??
            (Platform.isAndroid &&
                    (widget.mode == ProcessingMode.milkyWay ||
                        widget.mode == ProcessingMode.starTrail ||
                        widget.mode == ProcessingMode.meteor)
                ? StandardBackgroundProgressScreen(session: _session)
                : ProcessingProgressScreen(session: _session)),
      ),
    );
    if (mounted && _session.status != SessionStatus.ready) {
      _session.resetToReady();
    }
  }

  @override
  Widget build(BuildContext context) {
    final Color accent = _accentForMode(widget.mode);

    return Scaffold(
      appBar: AppBar(title: Text(widget.mode.label)),
      body: StarfieldBackground(
        child: SafeArea(
          child: Column(
            children: <Widget>[
              Expanded(
                child: _session.files.isEmpty
                    ? _EmptySelection(
                        mode: widget.mode,
                        description: widget.description,
                        accent: accent,
                        isPicking: _isPicking,
                        onSelect: _selectFiles,
                      )
                    : _SelectedFileGrid(
                        session: _session,
                        accent: accent,
                        isPicking: _isPicking,
                        onAdd: _selectFiles,
                      ),
              ),
              _SessionFooter(
                session: _session,
                accent: accent,
                onStart: _startProcessing,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _EmptySelection extends StatelessWidget {
  const _EmptySelection({
    required this.mode,
    required this.description,
    required this.accent,
    required this.isPicking,
    required this.onSelect,
  });

  final ProcessingMode mode;
  final String description;
  final Color accent;
  final bool isPicking;
  final VoidCallback onSelect;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
      children: <Widget>[
        _ModeIntro(mode: mode, accent: accent),
        const SizedBox(height: 18),
        Card(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 30, 24, 26),
            child: Column(
              children: <Widget>[
                Container(
                  width: 76,
                  height: 76,
                  decoration: BoxDecoration(
                    color: accent.withValues(alpha: 0.12),
                    shape: BoxShape.circle,
                    border: Border.all(color: accent.withValues(alpha: 0.45)),
                  ),
                  child: Icon(
                    Icons.add_photo_alternate_outlined,
                    size: 38,
                    color: accent,
                  ),
                ),
                const SizedBox(height: 20),
                const Text(
                  '撮影画像を追加',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 8),
                Text(
                  description,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: MobileStackColors.muted,
                    height: 1.55,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  '開始には${mode.minimumInputCount}枚以上必要です',
                  style: TextStyle(color: accent, fontSize: 12),
                ),
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: isPicking ? null : onSelect,
                    style: FilledButton.styleFrom(backgroundColor: accent),
                    icon: isPicking
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(Icons.add_rounded),
                    label: Text(isPicking ? '読み込み中…' : 'RAW画像を選択'),
                  ),
                ),
                const SizedBox(height: 12),
                const Text(
                  '本番センサー展開：Sony ARW / Nikon NEF・NRW',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: MobileStackColors.muted,
                    fontSize: 10,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _ModeIntro extends StatelessWidget {
  const _ModeIntro({required this.mode, required this.accent});

  final ProcessingMode mode;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Container(
          width: 52,
          height: 52,
          decoration: BoxDecoration(
            color: accent.withValues(alpha: 0.14),
            borderRadius: BorderRadius.circular(15),
            border: Border.all(color: accent.withValues(alpha: 0.5)),
          ),
          child: Icon(_iconForMode(mode), color: accent, size: 29),
        ),
        const SizedBox(width: 13),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                mode.label,
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                mode.shortDescription,
                style: const TextStyle(
                  color: MobileStackColors.muted,
                  fontSize: 11,
                  height: 1.4,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _SelectedFileGrid extends StatelessWidget {
  const _SelectedFileGrid({
    required this.session,
    required this.accent,
    required this.isPicking,
    required this.onAdd,
  });

  final ProcessingSession session;
  final Color accent;
  final bool isPicking;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: <Widget>[
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 14),
          sliver: SliverToBoxAdapter(
            child: _ModeIntro(mode: session.mode, accent: accent),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          sliver: SliverToBoxAdapter(
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    '${session.files.length}枚を選択',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                  ),
                ),
                TextButton.icon(
                  onPressed: isPicking ? null : onAdd,
                  icon: isPicking
                      ? const SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.add_rounded),
                  label: const Text('追加'),
                ),
                TextButton(
                  onPressed: session.clearFiles,
                  child: const Text('全解除'),
                ),
              ],
            ),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
          sliver: SliverGrid.builder(
            itemCount: session.files.length,
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              childAspectRatio: 0.72,
            ),
            itemBuilder: (BuildContext context, int index) {
              final RawInputFile file = session.files[index];
              return _RawFileTile(
                file: file,
                index: index,
                accent: accent,
                onRemove: () => session.removeFile(file.path),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _RawFileTile extends StatelessWidget {
  const _RawFileTile({
    required this.file,
    required this.index,
    required this.accent,
    required this.onRemove,
  });

  final RawInputFile file;
  final int index;
  final Color accent;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final String sourceDetail = file.metadata == null
        ? _formatBytes(file.byteLength)
        : '${file.metadata!.width}×${file.metadata!.height}'
            ' · ${file.metadata!.cfaPattern.name.toUpperCase()}';
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: MobileStackColors.outline),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[
            Color(0xFF182C4C),
            Color(0xFF421F4B),
            Color(0xFF0C101A),
          ],
          stops: <double>[0, 0.58, 1],
        ),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: Stack(
          children: <Widget>[
            Positioned.fill(
              child: file.thumbnailBytes == null
                  ? Icon(
                      Icons.auto_awesome_rounded,
                      size: 34,
                      color: Colors.white.withValues(alpha: 0.82),
                    )
                  : Image.memory(
                      file.thumbnailBytes!,
                      fit: BoxFit.cover,
                      cacheWidth: 360,
                      gaplessPlayback: true,
                      filterQuality: FilterQuality.medium,
                      errorBuilder: (_, __, ___) => Icon(
                        Icons.broken_image_outlined,
                        size: 34,
                        color: Colors.white.withValues(alpha: 0.82),
                      ),
                    ),
            ),
            Positioned(
              top: 6,
              left: 6,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
                decoration: BoxDecoration(
                  color: const Color(0xCC060912),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  '${index + 1}',
                  style: const TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ),
            Positioned(
              top: 4,
              right: 4,
              child: IconButton(
                tooltip: '選択から外す',
                visualDensity: VisualDensity.compact,
                style: IconButton.styleFrom(
                  backgroundColor: const Color(0xCC101521),
                  foregroundColor: Colors.white,
                ),
                onPressed: onRemove,
                icon: const Icon(Icons.close_rounded, size: 17),
              ),
            ),
            Positioned(
              left: 5,
              right: 5,
              bottom: 5,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
                decoration: BoxDecoration(
                  color: const Color(0xD905070D),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      file.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 10),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${file.probe?.format.label ?? _fileExtension(file.name)}'
                      ' · $sourceDetail',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: accent, fontSize: 9),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SessionFooter extends StatelessWidget {
  const _SessionFooter({
    required this.session,
    required this.accent,
    required this.onStart,
  });

  final ProcessingSession session;
  final Color accent;
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    final int remaining = session.mode.minimumInputCount - session.files.length;

    return Material(
      elevation: 12,
      color: const Color(0xF2070A12),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(
                      '${session.files.length}枚 · ${_formatBytes(session.totalBytes)}',
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      remaining > 0 ? 'あと$remaining枚追加すると次へ進めます' : '画像選択完了',
                      style: TextStyle(
                        color: remaining > 0
                            ? MobileStackColors.muted
                            : MobileStackColors.success,
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              FilledButton.icon(
                onPressed: session.canStart ? onStart : null,
                style: FilledButton.styleFrom(backgroundColor: accent),
                icon: const Icon(Icons.arrow_forward_rounded),
                label: const Text('次へ'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

Color _accentForMode(ProcessingMode mode) => switch (mode) {
      ProcessingMode.milkyWay => const Color(0xFF8151FF),
      ProcessingMode.starTrail => const Color(0xFF2C79FF),
      ProcessingMode.meteor => const Color(0xFF28AE6F),
      ProcessingMode.focusStack => const Color(0xFFF08A5D),
    };

IconData _iconForMode(ProcessingMode mode) => switch (mode) {
      ProcessingMode.milkyWay => Icons.auto_awesome_rounded,
      ProcessingMode.starTrail => Icons.motion_photos_on_rounded,
      ProcessingMode.meteor => Icons.bolt_rounded,
      ProcessingMode.focusStack => Icons.filter_center_focus_rounded,
    };

String _fileExtension(String name) {
  final int dot = name.lastIndexOf('.');
  if (dot < 0 || dot == name.length - 1) return 'RAW';
  return name.substring(dot + 1).toUpperCase();
}

String _formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  final double kib = bytes / 1024;
  if (kib < 1024) return '${kib.toStringAsFixed(1)} KB';
  final double mib = kib / 1024;
  if (mib < 1024) return '${mib.toStringAsFixed(1)} MB';
  return '${(mib / 1024).toStringAsFixed(2)} GB';
}
