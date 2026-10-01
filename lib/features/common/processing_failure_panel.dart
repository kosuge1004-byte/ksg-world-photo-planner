import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/diagnostics/diagnostic_log.dart';

import '../../core/diagnostics/processing_failure_report.dart';
import '../../design/mobile_stack_theme.dart';

class ProcessingFailurePanel extends StatelessWidget {
  const ProcessingFailurePanel({required this.report, super.key});

  final ProcessingFailureReport report;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            const Text(
              '失敗した工程',
              style: TextStyle(color: MobileStackColors.muted, fontSize: 11),
            ),
            const SizedBox(height: 2),
            Text(
              report.stage.label,
              key: const Key('failure-stage'),
              style: const TextStyle(
                color: MobileStackColors.warning,
                fontWeight: FontWeight.w800,
              ),
            ),
            if (report.substage != null) ...<Widget>[
              const SizedBox(height: 3),
              Text(
                report.substage!,
                style: const TextStyle(
                  color: MobileStackColors.muted,
                  fontSize: 10,
                ),
              ),
            ],
            const SizedBox(height: 12),
            const Text(
              'エラー',
              style: TextStyle(color: MobileStackColors.muted, fontSize: 11),
            ),
            Text(
              report.exceptionType,
              key: const Key('failure-exception-type'),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 10),
            const Text(
              '内容',
              style: TextStyle(color: MobileStackColors.muted, fontSize: 11),
            ),
            SelectableText(
              report.message,
              key: const Key('failure-message'),
              style: const TextStyle(fontSize: 12, height: 1.45),
            ),
            const SizedBox(height: 8),
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              childrenPadding: EdgeInsets.zero,
              title: const Text('詳細を表示'),
              children: <Widget>[
                Container(
                  constraints: const BoxConstraints(maxHeight: 260),
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: const Color(0xFF080B12),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: MobileStackColors.outline),
                  ),
                  child: SingleChildScrollView(
                    child: SelectableText(
                      report.toPlainText(),
                      key: const Key('failure-full-report'),
                      style: const TextStyle(
                        color: MobileStackColors.muted,
                        fontSize: 10,
                        height: 1.45,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              key: const Key('copy-error-details'),
              onPressed: () async {
                await Clipboard.setData(
                  ClipboardData(text: report.toPlainText()),
                );
                if (!context.mounted) return;
                ScaffoldMessenger.of(
                  context,
                ).showSnackBar(const SnackBar(content: Text('エラー内容をコピーしました')));
              },
              icon: const Icon(Icons.copy_rounded),
              label: const Text('エラー内容をコピー'),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              key: const Key('share-diagnostic-log'),
              onPressed: () async {
                final List<File> files = await DiagnosticLog.exportForSharing();
                if (!context.mounted) return;
                if (files.isEmpty) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('診断ログがまだありません')),
                  );
                  return;
                }
                await SharePlus.instance.share(
                  ShareParams(
                    files: <XFile>[
                      for (final File file in files)
                        XFile(file.path, mimeType: 'text/plain'),
                    ],
                    text: report.toPlainText(),
                    subject: 'Mobile Stack 診断ログ',
                  ),
                );
              },
              icon: const Icon(Icons.ios_share_rounded),
              label: const Text('診断ログをファイルで共有'),
            ),
          ],
        ),
      ),
    );
  }
}
