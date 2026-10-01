import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/io/file_picker_raw_input_reader.dart';
import '../../core/io/raw_input_contract.dart';
import '../../core/models/processing_mode.dart';
import '../../core/raw/native_raw_decoder_factory.dart';
import '../../core/session/processing_session.dart';
import '../../design/mobile_stack_theme.dart';
import 'processing_progress_screen.dart';
import 'standard_background_progress_screen.dart';
import 'raw_selection_screen.dart';

/// Optional dark/flat calibration-frame selection step, shared by the
/// three main (non-experimental) processing modes — star trail, Milky
/// Way, meteor — placed before [RawSelectionScreen]'s own light-frame
/// picker.
///
/// Mirrors `cfa_drizzle_milky_way_screen.dart`'s own established
/// two-step structure (Work106): a small calibration-frame options
/// screen first, then [RawSelectionScreen] for the actual light frames,
/// with the collected calibration-frame paths passed through via
/// [RawSelectionScreen]'s `progressScreenBuilder` (Work94) so this
/// screen never needs to touch [RawSelectionScreen] itself.
///
/// Until Work111, `runPhase2ValidatedJob`'s own `masterDark`/
/// `masterFlat` support (Work109) — and the dark/flat subtraction and
/// hot-pixel-detection pipeline behind it (Work96-108) — was reachable
/// only from the CFA-drizzle experimental mode's own calibration screen
/// (Work106), even though the underlying `runPhase2ValidatedJob` itself
/// is what all three main modes actually call
/// (`processing_progress_screen.dart`'s own `initState`). This screen
/// closes that gap for the three main modes, reusing
/// [ProcessingProgressScreen]'s own newly-added `darkFramePaths`/
/// `flatFramePaths` parameters (Work111).
///
/// This file has not been executed against the Dart SDK, nor rendered
/// on a device — the same visual-correctness caveat this project's
/// other UI files' own doc comments state applies here too.
class CalibrationFrameOptionsScreen extends StatefulWidget {
  const CalibrationFrameOptionsScreen({
    required this.mode,
    required this.lightFrameDescription,
    required this.appBarTitle,
    super.key,
  });

  final ProcessingMode mode;

  /// Shown on [RawSelectionScreen] once the user proceeds past this
  /// screen — the same description text `MilkyWayScreen`/
  /// `StarTrailScreen`/`MeteorScreen` already pass directly today.
  final String lightFrameDescription;
  final String appBarTitle;

  @override
  State<CalibrationFrameOptionsScreen> createState() =>
      _CalibrationFrameOptionsScreenState();
}

class _CalibrationFrameOptionsScreenState
    extends State<CalibrationFrameOptionsScreen> {
  final FilePickerRawInputReader _reader = FilePickerRawInputReader(
    metadataProbe: createFeatureFlaggedNativeRawMetadataProbe(),
  );
  final List<RawInputFile> _darkFrames = <RawInputFile>[];
  final List<RawInputFile> _flatFrames = <RawInputFile>[];
  bool _isPicking = false;

  Future<void> _pickInto(List<RawInputFile> target) async {
    if (_isPicking) return;
    setState(() => _isPicking = true);
    try {
      final RawSelectionResult selection = await _reader.selectRawFiles();
      setState(() => target.addAll(selection.files));
      if (!mounted || selection.rejected.isEmpty) return;
      final RawInputRejection first = selection.rejected.first;
      final String prefix = selection.rejected.length == 1
          ? first.name
          : '${selection.rejected.length}件';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$prefixを追加できませんでした：${first.reason}')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('RAWファイルを読み込めませんでした：$error')),
      );
    } finally {
      if (mounted) setState(() => _isPicking = false);
    }
  }

  void _proceedToLightFrameSelection() {
    // 較正用フレームのファイルパスをこの時点でキャプチャしておき、
    // RawSelectionScreen(ライトフレーム選択)へ進んだ後にこの画面の
    // 状態が変わっても、既に開始した処理には影響しないようにする
    // (cfa_drizzle_milky_way_screen.dart, Work106と同じ設計)。
    final List<String> darkFramePaths = <String>[
      for (final RawInputFile file in _darkFrames) file.path,
    ];
    final List<String> flatFramePaths = <String>[
      for (final RawInputFile file in _flatFrames) file.path,
    ];
    Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => RawSelectionScreen(
          mode: widget.mode,
          description: widget.lightFrameDescription,
          progressScreenBuilder: (ProcessingSession session) =>
              (Platform.isAndroid &&
                      (widget.mode == ProcessingMode.milkyWay ||
                          widget.mode == ProcessingMode.starTrail ||
                          widget.mode == ProcessingMode.meteor))
                  ? StandardBackgroundProgressScreen(
                      session: session,
                      darkFramePaths:
                          darkFramePaths.isEmpty ? null : darkFramePaths,
                      flatFramePaths:
                          flatFramePaths.isEmpty ? null : flatFramePaths,
                    )
                  : ProcessingProgressScreen(
                      session: session,
                      darkFramePaths:
                          darkFramePaths.isEmpty ? null : darkFramePaths,
                      flatFramePaths:
                          flatFramePaths.isEmpty ? null : flatFramePaths,
                    ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.appBarTitle)),
      body: StarfieldBackground(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
            children: <Widget>[
              const Text(
                'ダーク/フラットフレーム（任意）',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 8),
              const Text(
                'センサー固有のノイズ・周辺減光を補正します。撮影しなかった'
                '場合は、追加せずに次へ進んでください。',
                style: TextStyle(
                  color: MobileStackColors.muted,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 20),
              _CalibrationFrameSection(
                title: 'ダークフレーム',
                subtitle: 'レンズキャップをした状態で、ライトフレームと'
                    '同じ露出設定で撮影したもの',
                files: _darkFrames,
                isPicking: _isPicking,
                onAdd: () => _pickInto(_darkFrames),
                onClear: () => setState(_darkFrames.clear),
              ),
              const SizedBox(height: 16),
              _CalibrationFrameSection(
                title: 'フラットフレーム',
                subtitle: '一様に明るい面（薄明の空など）を撮影したもの',
                files: _flatFrames,
                isPicking: _isPicking,
                onAdd: () => _pickInto(_flatFrames),
                onClear: () => setState(_flatFrames.clear),
              ),
              const SizedBox(height: 28),
              FilledButton.icon(
                onPressed: _proceedToLightFrameSelection,
                icon: const Icon(Icons.arrow_forward_rounded),
                label: const Text('次へ（撮影画像を選択）'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CalibrationFrameSection extends StatelessWidget {
  const _CalibrationFrameSection({
    required this.title,
    required this.subtitle,
    required this.files,
    required this.isPicking,
    required this.onAdd,
    required this.onClear,
  });

  final String title;
  final String subtitle;
  final List<RawInputFile> files;
  final bool isPicking;
  final VoidCallback onAdd;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              title,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            Text(
              subtitle,
              style: const TextStyle(
                color: MobileStackColors.muted,
                fontSize: 12,
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    files.isEmpty ? '未選択' : '${files.length}枚選択済み',
                    style: TextStyle(
                      color: files.isEmpty
                          ? MobileStackColors.muted
                          : MobileStackColors.success,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (files.isNotEmpty)
                  TextButton(onPressed: onClear, child: const Text('解除')),
                TextButton.icon(
                  onPressed: isPicking ? null : onAdd,
                  icon: const Icon(Icons.add_rounded, size: 18),
                  label: const Text('追加'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
