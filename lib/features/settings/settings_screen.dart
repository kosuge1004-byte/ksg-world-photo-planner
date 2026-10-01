import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/diagnostics/diagnostic_log.dart';
import '../../core/export/output_image_format.dart';
import '../../core/export/lightroom_storage_preset.dart';
import '../../core/quality/processing_quality_level.dart';
import '../../core/settings/app_settings.dart';
import '../../design/mobile_stack_theme.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  static const String routeName = '/settings';

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  OutputImageFormat _outputFormat = AppSettings.defaultOutputFormat;
  ProcessingQualityLevel _qualityLevel = AppSettings.defaultQualityLevel;
  LightroomStoragePreset _storagePreset = AppSettings.defaultStoragePreset;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final values = await Future.wait<Object>(<Future<Object>>[
      AppSettings.loadOutputFormat(),
      AppSettings.loadQualityLevel(),
      AppSettings.loadStoragePreset(),
    ]);
    if (!mounted) return;
    setState(() {
      _outputFormat = values[0] as OutputImageFormat;
      _qualityLevel = values[1] as ProcessingQualityLevel;
      _storagePreset = values[2] as LightroomStoragePreset;
      _loading = false;
    });
  }

  Future<void> _chooseQuality() async {
    final value = await showModalBottomSheet<ProcessingQualityLevel>(
      context: context,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: <Widget>[
            const ListTile(
                title: Text('処理画質を選択',
                    style: TextStyle(fontWeight: FontWeight.w800))),
            for (final item in ProcessingQualityLevel.values.reversed)
              ListTile(
                title: Text(item.label),
                subtitle: Text(item.detail),
                trailing: Icon(item == _qualityLevel
                    ? Icons.radio_button_checked_rounded
                    : Icons.radio_button_unchecked_rounded),
                onTap: () => Navigator.pop(context, item),
              ),
          ],
        ),
      ),
    );
    if (value == null) return;
    await AppSettings.saveQualityLevel(value);
    if (mounted) setState(() => _qualityLevel = value);
  }

  Future<void> _chooseStorage() async {
    final value = await showModalBottomSheet<LightroomStoragePreset>(
      context: context,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: <Widget>[
            const ListTile(
                title: Text('ファイル容量',
                    style: TextStyle(fontWeight: FontWeight.w800))),
            for (final item in LightroomStoragePreset.values)
              ListTile(
                title: Text(item.label),
                subtitle: Text(item.detail),
                trailing: Icon(item == _storagePreset
                    ? Icons.radio_button_checked_rounded
                    : Icons.radio_button_unchecked_rounded),
                onTap: () => Navigator.pop(context, item),
              ),
          ],
        ),
      ),
    );
    if (value == null) return;
    await AppSettings.saveStoragePreset(value);
    if (mounted) {
      setState(() {
        _storagePreset = value;
        _outputFormat = value.outputFormat;
      });
    }
  }

  Future<void> _chooseOutputFormat() async {
    if (_loading) return;
    final OutputImageFormat? selected =
        await showModalBottomSheet<OutputImageFormat>(
      context: context,
      isScrollControlled: true,
      builder: (BuildContext context) => _OutputFormatSheet(
        selected: _outputFormat,
      ),
    );
    if (selected == null || selected == _outputFormat) return;
    await AppSettings.saveOutputFormat(selected);
    final LightroomStoragePreset storage = LightroomStoragePreset.values
        .firstWhere((value) => value.outputFormat == selected);
    await AppSettings.saveStoragePreset(storage);
    if (!mounted) return;
    setState(() {
      _outputFormat = selected;
      _storagePreset = storage;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('設定')),
      body: ListView(
        children: <Widget>[
          const ListTile(
            title: Text('並列処理'),
            subtitle: Text('自動（最大12並列）'),
          ),
          ListTile(
            title: const Text('処理画質'),
            subtitle: Text(_loading
                ? '読み込み中…'
                : '${_qualityLevel.label} — ${_qualityLevel.detail}'),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: _loading ? null : _chooseQuality,
          ),
          ListTile(
            title: const Text('ファイル容量'),
            subtitle: Text(_loading
                ? '読み込み中…'
                : '${_storagePreset.label} — ${_storagePreset.detail}'),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: _loading ? null : _chooseStorage,
          ),
          ListTile(
            title: const Text('詳細出力形式（保存容量に連動）'),
            subtitle: Text(_loading ? '読み込み中…' : _outputFormat.label),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: _loading ? null : _chooseOutputFormat,
          ),
          const ListTile(
            title: Text('一時データ'),
            subtitle: Text('処理終了時に自動削除'),
          ),
          const ListTile(
            title: Text('プロジェクト保存'),
            subtitle: Text('使用しない'),
          ),
          ListTile(
            title: const Text('診断ログをファイルで共有'),
            subtitle: const Text(
              '処理が止まった原因調査用。直近と1つ前の処理記録をテキストファイルとして保存・送信します（長いログもそのまま渡せます）',
            ),
            trailing: const Icon(Icons.ios_share_rounded),
            onTap: _shareDiagnosticLog,
          ),
          ListTile(
            title: const Text('診断ログをコピー'),
            subtitle: const Text('短いログ向け。直近の処理記録を文字列としてコピーします'),
            trailing: const Icon(Icons.copy_rounded),
            onTap: _copyDiagnosticLog,
          ),
        ],
      ),
    );
  }

  Future<void> _shareDiagnosticLog() async {
    final List<File> files = await DiagnosticLog.exportForSharing();
    if (!mounted) return;
    if (files.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('診断ログがまだありません。処理を一度実行してください。')),
      );
      return;
    }
    try {
      await SharePlus.instance.share(
        ShareParams(
          files: <XFile>[
            for (final File file in files)
              XFile(file.path, mimeType: 'text/plain'),
          ],
          subject: 'Mobile Stack 診断ログ',
        ),
      );
    } on Object {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('診断ログを共有できませんでした。')),
      );
    }
  }

  Future<void> _copyDiagnosticLog() async {
    final File? file = await DiagnosticLog.existingLogFile();
    if (!mounted) return;
    if (file == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('診断ログがまだありません。処理を一度実行してください。')),
      );
      return;
    }

    try {
      final String logText = await file.readAsString();
      if (!mounted) return;
      if (logText.trim().isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('診断ログが空です。')),
        );
        return;
      }
      await Clipboard.setData(ClipboardData(text: logText));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('診断ログをコピーしました。')),
      );
    } on Object {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('診断ログをコピーできませんでした。')),
      );
    }
  }
}

class _OutputFormatSheet extends StatelessWidget {
  const _OutputFormatSheet({required this.selected});

  final OutputImageFormat selected;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            const Text(
              '出力形式を選択',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            const Text(
              '形式名と説明を確認して選択してください。',
              style: TextStyle(color: MobileStackColors.muted, fontSize: 12),
            ),
            const SizedBox(height: 12),
            for (final OutputImageFormat format in selectableOutputFormats)
              _OutputFormatChoice(
                format: format,
                selected: format == selected,
              ),
          ],
        ),
      ),
    );
  }
}

class _OutputFormatChoice extends StatelessWidget {
  const _OutputFormatChoice({required this.format, required this.selected});

  final OutputImageFormat format;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => Navigator.of(context).pop(format),
        child: DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: selected
                  ? MobileStackColors.accent
                  : MobileStackColors.outline,
              width: selected ? 2 : 1,
            ),
            color: MobileStackColors.surfaceHigh,
          ),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Icon(
                    selected
                        ? Icons.radio_button_checked_rounded
                        : Icons.radio_button_unchecked_rounded,
                    color: selected
                        ? MobileStackColors.accent
                        : MobileStackColors.muted,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        format.label,
                        style: const TextStyle(
                          fontWeight: FontWeight.w800,
                          fontSize: 15,
                        ),
                      ),
                      const SizedBox(height: 5),
                      Text(
                        format.detail,
                        style: const TextStyle(
                          color: MobileStackColors.muted,
                          fontSize: 12,
                          height: 1.45,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
