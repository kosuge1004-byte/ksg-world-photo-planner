import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/diagnostics/processing_failure_report.dart';
import 'package:mobile_stack/core/export/output_image_format.dart';
import 'package:mobile_stack/core/io/raw_input_contract.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/features/common/processing_failure_panel.dart';

void main() {
  testWidgets('4/4 RAW成功後の後段例外も工程・型・内容・コピーを表示する', (WidgetTester tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (_) async => null);
    final ProcessingFailureReport report = ProcessingFailureReport.capture(
      error: StateError('synthetic downstream export failure'),
      stackTrace: StackTrace.fromString('#0 downstreamExport'),
      mode: ProcessingMode.milkyWay,
      stage: ProcessingFailureStage.linearDngExport,
      inputs: const <RawInputFile>[
        RawInputFile(path: '1.arw', byteLength: 1),
        RawInputFile(path: '2.arw', byteLength: 1),
        RawInputFile(path: '3.arw', byteLength: 1),
        RawInputFile(path: '4.arw', byteLength: 1),
      ],
      reference: const RawInputFile(path: '3.arw', byteLength: 1),
      referenceIndex: 2,
      outputFormat: OutputImageFormat.linearDng,
      completedJobs: 4,
      failedJobs: 0,
      cancelled: false,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: ProcessingFailurePanel(report: report),
          ),
        ),
      ),
    );

    expect(find.text('Linear DNG書き出し'), findsOneWidget);
    expect(find.text('StateError'), findsOneWidget);
    expect(
      find.textContaining('synthetic downstream export failure'),
      findsOneWidget,
    );
    expect(report.completedJobs, 4);
    expect(report.failedJobs, 0);

    final Finder copyButton = find.byKey(const Key('copy-error-details'));
    final OutlinedButton button = tester.widget<OutlinedButton>(copyButton);
    button.onPressed!();
    await tester.pumpAndSettle();
    expect(find.text('エラー内容をコピーしました'), findsOneWidget);
  });
}
