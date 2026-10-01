import 'package:flutter/material.dart';

import '../../core/export/lightroom_storage_preset.dart';
import '../../core/export/output_image_format.dart';
import '../../core/settings/app_settings.dart';
import '../../design/mobile_stack_theme.dart';

class FocusStackSettingsResult {
  const FocusStackSettingsResult({
    required this.outputFormat,
    required this.storagePreset,
    required this.showOmissionCandidates,
    required this.autoExcludeOmissionCandidates,
  });

  final OutputImageFormat outputFormat;
  final LightroomStoragePreset storagePreset;
  final bool showOmissionCandidates;
  final bool autoExcludeOmissionCandidates;
}

class FocusStackSettingsScreen extends StatefulWidget {
  const FocusStackSettingsScreen({
    required this.outputFormat,
    required this.storagePreset,
    required this.showOmissionCandidates,
    required this.autoExcludeOmissionCandidates,
    super.key,
  });

  final OutputImageFormat outputFormat;
  final LightroomStoragePreset storagePreset;
  final bool showOmissionCandidates;
  final bool autoExcludeOmissionCandidates;

  @override
  State<FocusStackSettingsScreen> createState() =>
      _FocusStackSettingsScreenState();
}

class _FocusStackSettingsScreenState extends State<FocusStackSettingsScreen> {
  late OutputImageFormat _outputFormat;
  late LightroomStoragePreset _storagePreset;
  late bool _showOmissionCandidates;
  late bool _autoExcludeOmissionCandidates;
  bool _normalizeExposure = AppSettings.defaultFocusExposureNormalization;
  bool _pyramidBlend = AppSettings.defaultFocusPyramidBlend;

  @override
  void initState() {
    super.initState();
    _outputFormat = widget.outputFormat;
    _storagePreset = widget.storagePreset;
    _showOmissionCandidates = widget.showOmissionCandidates;
    _autoExcludeOmissionCandidates = widget.autoExcludeOmissionCandidates;
    AppSettings.loadFocusExposureNormalization().then((bool value) {
      if (mounted) setState(() => _normalizeExposure = value);
    });
    AppSettings.loadFocusPyramidBlend().then((bool value) {
      if (mounted) setState(() => _pyramidBlend = value);
    });
  }

  void _setOutputFormat(OutputImageFormat value) {
    setState(() {
      _outputFormat = value;
      for (final LightroomStoragePreset preset
          in LightroomStoragePreset.values) {
        if (preset.outputFormat == value) {
          _storagePreset = preset;
          break;
        }
      }
    });
    AppSettings.saveOutputFormat(value);
  }

  void _setStoragePreset(LightroomStoragePreset value) {
    setState(() {
      _storagePreset = value;
      _outputFormat = value.outputFormat;
    });
    AppSettings.saveStoragePreset(value);
  }

  void _accept() {
    Navigator.of(context).pop(
      FocusStackSettingsResult(
        outputFormat: _outputFormat,
        storagePreset: _storagePreset,
        showOmissionCandidates: _showOmissionCandidates,
        autoExcludeOmissionCandidates: _autoExcludeOmissionCandidates,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    const Color accent = Color(0xFFF08A5D);
    return Scaffold(
      appBar: AppBar(title: const Text('各種設定')),
      body: StarfieldBackground(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 24),
            children: <Widget>[
              const _FixedQualityCard(),
              const SizedBox(height: 12),
              _SettingCard(
                icon: Icons.high_quality_outlined,
                title: '出力方式',
                child: DropdownButton<OutputImageFormat>(
                  value: _outputFormat,
                  isExpanded: true,
                  underline: const SizedBox.shrink(),
                  onChanged: (OutputImageFormat? value) {
                    if (value != null) _setOutputFormat(value);
                  },
                  items: <DropdownMenuItem<OutputImageFormat>>[
                    for (final value in selectableOutputFormats)
                      DropdownMenuItem<OutputImageFormat>(
                        value: value,
                        child: Text(value.label),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              _SettingCard(
                icon: Icons.photo_size_select_large_rounded,
                title: 'ファイル容量',
                child: DropdownButton<LightroomStoragePreset>(
                  value: _storagePreset,
                  isExpanded: true,
                  underline: const SizedBox.shrink(),
                  onChanged: (LightroomStoragePreset? value) {
                    if (value != null) _setStoragePreset(value);
                  },
                  items: <DropdownMenuItem<LightroomStoragePreset>>[
                    for (final value in LightroomStoragePreset.values)
                      DropdownMenuItem<LightroomStoragePreset>(
                        value: value,
                        child: Text(
                          '${value.label} — ${value.detail}',
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Card(
                child: Column(
                  children: <Widget>[
                    CheckboxListTile(
                      value: _showOmissionCandidates,
                      controlAffinity: ListTileControlAffinity.leading,
                      title: const Text('省略可能な写真を表示'),
                      subtitle: const Text(
                        '他の写真で合焦領域をカバーできる写真を候補表示します。',
                        style: TextStyle(color: MobileStackColors.muted),
                      ),
                      onChanged: (bool? value) => setState(
                        () => _showOmissionCandidates = value ?? false,
                      ),
                    ),
                    const Divider(height: 1),
                    CheckboxListTile(
                      value: _autoExcludeOmissionCandidates,
                      controlAffinity: ListTileControlAffinity.leading,
                      title: const Text('省略可能な写真を自動除外'),
                      subtitle: const Text(
                        '有効時のみ使用OFFにします。合焦カバーを失う写真は除外しません。',
                        style: TextStyle(color: MobileStackColors.muted),
                      ),
                      onChanged: (bool? value) {
                        final bool next = value ?? false;
                        setState(() {
                          _autoExcludeOmissionCandidates = next;
                          if (next) _showOmissionCandidates = true;
                        });
                      },
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Card(
                child: SwitchListTile.adaptive(
                  value: _normalizeExposure,
                  title: const Text('写真間の明るさ・色を自動で揃える'),
                  subtitle: const Text(
                    '基準写真に合わせて各写真の明るさと色を補正してから合成します。'
                    'マクロ撮影の露出差や照明のちらつきによるまだら・段差を抑えます。',
                    style: TextStyle(color: MobileStackColors.muted),
                  ),
                  onChanged: (bool value) {
                    setState(() => _normalizeExposure = value);
                    AppSettings.saveFocusExposureNormalization(value);
                  },
                ),
              ),
              const SizedBox(height: 12),
              Card(
                child: SwitchListTile.adaptive(
                  value: _pyramidBlend,
                  title: const Text('境界をなめらかに合成（ピラミッド合成）'),
                  subtitle: const Text(
                    '細部は合焦した写真のまま、明るさの変化だけを広い範囲でなじませて、'
                    '写真の切り替わり目の段差・継ぎ目を目立たなくします。',
                    style: TextStyle(color: MobileStackColors.muted),
                  ),
                  onChanged: (bool value) {
                    setState(() => _pyramidBlend = value);
                    AppSettings.saveFocusPyramidBlend(value);
                  },
                ),
              ),
              const SizedBox(height: 22),
              FilledButton.icon(
                style: FilledButton.styleFrom(
                  backgroundColor: accent,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
                onPressed: _accept,
                icon: const Icon(Icons.arrow_forward_rounded),
                label: const Text('この設定で次へ'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FixedQualityCard extends StatelessWidget {
  const _FixedQualityCard();

  @override
  Widget build(BuildContext context) {
    return const _SettingCard(
      icon: Icons.tune_rounded,
      title: '画質',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text('最高画質（固定）', style: TextStyle(fontWeight: FontWeight.w800)),
          SizedBox(height: 4),
          Text(
            '深度合成は合焦境界の精度を優先し、原寸RAWの高精度処理を維持します。',
            style: TextStyle(color: MobileStackColors.muted, height: 1.4),
          ),
        ],
      ),
    );
  }
}

class _SettingCard extends StatelessWidget {
  const _SettingCard({
    required this.icon,
    required this.title,
    required this.child,
  });

  final IconData icon;
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(icon, size: 19, color: MobileStackColors.muted),
                const SizedBox(width: 8),
                Text(title,
                    style: const TextStyle(fontWeight: FontWeight.w800)),
              ],
            ),
            const SizedBox(height: 8),
            child,
          ],
        ),
      ),
    );
  }
}
