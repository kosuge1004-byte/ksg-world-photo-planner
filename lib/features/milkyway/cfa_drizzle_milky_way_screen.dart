import 'package:flutter/material.dart';

import '../../core/io/file_picker_raw_input_reader.dart';
import '../../core/io/raw_input_contract.dart';
import '../../core/models/processing_mode.dart';
import '../../core/raw/native_raw_decoder_factory.dart';
import '../../core/session/processing_session.dart';
import '../../design/mobile_stack_theme.dart';
import '../common/raw_selection_screen.dart';
import 'cfa_drizzle_milky_way_progress_screen.dart';

/// Entry point for the experimental CFA-domain-drizzle-based Milky Way
/// pipeline (Work84-93). As of Work106, this is now itself a small
/// **calibration frame options** screen — reachable before the light-
/// frame selection screen — letting a user optionally pick dark/flat
/// calibration RAW files (Work96-105's own dark/flat subtraction
/// pipeline, until now only reachable by passing file paths directly in
/// code) before proceeding to [RawSelectionScreen] for the actual light
/// frames.
///
/// This two-step structure (calibration frames first, then light
/// frames) was chosen over inserting a picker *inside*
/// [RawSelectionScreen] itself: that screen is a full-screen, already-
/// established widget shared by every processing mode
/// (`StarTrailScreen`/`MilkyWayScreen`/`MeteorScreen`), and its own
/// layout has no natural place to compose additional picker sections
/// without risking its established behavior for those other callers.
/// A separate screen before it, passing the collected calibration frame
/// paths through to [RawSelectionScreen]'s own `progressScreenBuilder`
/// (Work94) via closure, avoids touching that shared screen at all.
///
/// See `cfa_drizzle_milky_way_progress_screen.dart`'s own doc comment
/// for why this pipeline exists as a second, clearly-labeled-
/// experimental entry point, not a replacement for
/// [ProcessingMode.milkyWay]'s existing `MilkyWayScreen`.
///
/// This file has not been executed against the Dart SDK, nor rendered
/// on a device (unavailable in the environment that wrote it) — the
/// same visual-correctness caveat this project's other UI files'
/// (`result_screen.dart`, Work65; `meteor_review_screen.dart`, Work66;
/// `cfa_drizzle_milky_way_progress_screen.dart`, Work94) own doc
/// comments state applies here too.
class CfaDrizzleMilkyWayScreen extends StatefulWidget {
  const CfaDrizzleMilkyWayScreen({super.key});

  static const String routeName = '/milky-way-cfa-drizzle-experimental';

  @override
  State<CfaDrizzleMilkyWayScreen> createState() =>
      _CfaDrizzleMilkyWayScreenState();
}

class _CfaDrizzleMilkyWayScreenState extends State<CfaDrizzleMilkyWayScreen> {
  final FilePickerRawInputReader _reader = FilePickerRawInputReader(
    metadataProbe: createFeatureFlaggedNativeRawMetadataProbe(),
  );
  final List<RawInputFile> _darkFrames = <RawInputFile>[];
  final List<RawInputFile> _flatFrames = <RawInputFile>[];
  bool _isPicking = false;
  final bool _enableLocalToneAdaptation = false;
  bool _enableRobustRejection = true;
  bool _enableLocalRegistration = true;

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
    // ダーク/フラットフレームのファイルパスと局所トーン適応の設定を
    // この時点でキャプチャしておき、RawSelectionScreen(ライトフレーム
    // 選択)へ進んだ後にこの画面の状態が変わっても、既に開始した処理
    // には影響しないようにする。
    final List<String> darkFramePaths = <String>[
      for (final RawInputFile file in _darkFrames) file.path,
    ];
    final List<String> flatFramePaths = <String>[
      for (final RawInputFile file in _flatFrames) file.path,
    ];
    final bool enableLocalToneAdaptation = _enableLocalToneAdaptation;
    final bool enableRobustRejection = _enableRobustRejection;
    final bool enableLocalRegistration = _enableLocalRegistration;
    Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => RawSelectionScreen(
          mode: ProcessingMode.milkyWay,
          requireReferenceSelection: false,
          enableMovingObjectRemovalSetting: false,
          description: 'RAWをデモザイクせず位置合わせしてドリズル合成し、'
              '暗い背景を持ち上げる局所トーン処理も適用する、実験的な'
              '高画質モードです。処理時間は通常モードより長くなります。',
          progressScreenBuilder: (ProcessingSession session) =>
              CfaDrizzleMilkyWayProgressScreen(
            session: session,
            darkFramePaths: darkFramePaths.isEmpty ? null : darkFramePaths,
            flatFramePaths: flatFramePaths.isEmpty ? null : flatFramePaths,
            enableLocalToneAdaptation: enableLocalToneAdaptation,
            enableRobustRejection: enableRobustRejection,
            enableLocalRegistration: enableLocalRegistration,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('高画質合成（実験的）')),
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
              const SizedBox(height: 16),
              Card(
                child: SwitchListTile(
                  title: const Text('局所トーン処理（Linear DNGでは未適用）'),
                  subtitle: const Text(
                    'Linear DNGにはトーン処理を焼き込みません。'
                    'TIFF/JPEG系出力を再び選べる場合にのみ使用します。',
                    style: TextStyle(fontSize: 12),
                  ),
                  value: false,
                  onChanged: null,
                ),
              ),
              const SizedBox(height: 8),
              Card(
                child: SwitchListTile(
                  title: const Text('宇宙線・異常値を除去（ロバスト合成）'),
                  subtitle: const Text(
                    '各フレームを個別に処理してから統計的に外れ値を'
                    '除去します。処理時間が数倍に増えます'
                    '（Work113-114で検証済み）',
                    style: TextStyle(fontSize: 12),
                  ),
                  value: _enableRobustRejection,
                  onChanged: (bool value) =>
                      setState(() => _enableRobustRejection = value),
                ),
              ),
              const SizedBox(height: 8),
              Card(
                child: SwitchListTile(
                  title: const Text('レンズ歪曲を補正（局所位置合わせ）'),
                  subtitle: const Text(
                    '大域的な位置合わせに加え、画面周辺のわずかな歪みも'
                    '補正します（Work119-122で検証済み）',
                    style: TextStyle(fontSize: 12),
                  ),
                  value: _enableLocalRegistration,
                  onChanged: (bool value) =>
                      setState(() => _enableLocalRegistration = value),
                ),
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
