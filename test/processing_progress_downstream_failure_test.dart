import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/diagnostics/processing_failure_report.dart';
import 'package:mobile_stack/core/engine/job_scheduler.dart';
import 'package:mobile_stack/core/export/output_image_format.dart';
import 'package:mobile_stack/core/io/raw_input_contract.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/core/session/processing_session.dart';
import 'package:mobile_stack/features/common/processing_progress_screen.dart';

void main() {
  testWidgets('completed 4 failed 0の後段例外を進捗失敗画面に表示する',
      (WidgetTester tester) async {
    const List<RawInputFile> inputs = <RawInputFile>[
      RawInputFile(path: '/raw/1.arw', byteLength: 1),
      RawInputFile(path: '/raw/2.arw', byteLength: 1),
      RawInputFile(path: '/raw/3.arw', byteLength: 1),
      RawInputFile(path: '/raw/4.arw', byteLength: 1),
    ];
    final ProcessingSession session =
        ProcessingSession(mode: ProcessingMode.milkyWay)
          ..addFiles(inputs)
          ..setReferencePath('/raw/3.arw');
    final ProcessingFailureReport report = ProcessingFailureReport.capture(
      error: ArgumentError('downstream DNG metadata failure'),
      stackTrace: StackTrace.fromString('#0 exportDng'),
      mode: ProcessingMode.milkyWay,
      stage: ProcessingFailureStage.linearDngExport,
      inputs: inputs,
      reference: inputs[2],
      referenceIndex: 2,
      outputFormat: OutputImageFormat.linearDng,
      completedJobs: 4,
      failedJobs: 0,
      cancelled: false,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: ProcessingProgressScreen(
          session: session,
          initialFailureReport: report,
          initialSnapshot: const JobSchedulerSnapshot(
            queuedCount: 0,
            activeCount: 0,
            completedCount: 4,
            failedCount: 0,
            cancelledCount: 0,
            overallProgress: 1,
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('処理に失敗しました'), findsOneWidget);
    expect(find.text('Linear DNG書き出し'), findsNWidgets(2));
    expect(find.text('ArgumentError'), findsOneWidget);
    expect(
        find.textContaining('downstream DNG metadata failure'), findsOneWidget);
    expect(find.text('完了'), findsOneWidget);
    expect(find.text('4'), findsOneWidget);
    expect(session.failureReport!.completedJobs, 4);
    expect(session.failureReport!.failedJobs, 0);
  });
}
