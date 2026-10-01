import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/diagnostics/processing_failure_report.dart';
import 'package:mobile_stack/core/export/output_image_format.dart';
import 'package:mobile_stack/core/io/raw_input_contract.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';

void main() {
  test('コピー用レポートに原因調査の必須項目とstack traceを保持する', () {
    final StackTrace stackTrace = StackTrace.fromString(
      '#0 Work247.syntheticExport (processing.dart:247:7)',
    );
    final ProcessingFailureReport report = ProcessingFailureReport.capture(
      error: ArgumentError('color transform is invalid'),
      stackTrace: stackTrace,
      mode: ProcessingMode.milkyWay,
      stage: ProcessingFailureStage.linearDngExport,
      substage: 'Color transform validation',
      inputs: const <RawInputFile>[
        RawInputFile(path: '/raw/one.arw', byteLength: 1),
        RawInputFile(path: '/raw/two.arw', byteLength: 1),
        RawInputFile(path: '/raw/three.arw', byteLength: 1),
        RawInputFile(path: '/raw/four.arw', byteLength: 1),
      ],
      reference: const RawInputFile(path: '/raw/three.arw', byteLength: 1),
      referenceIndex: 2,
      outputFormat: OutputImageFormat.linearDng,
      completedJobs: 4,
      failedJobs: 0,
      cancelled: false,
    );

    final String text = report.toPlainText();
    expect(text, contains('Stage: Linear DNG書き出し'));
    expect(text, contains('ExceptionType: ArgumentError'));
    expect(text, contains('color transform is invalid'));
    expect(text, contains('Mode: 天の川・星景スタック'));
    expect(text, contains('InputFrames: 4'));
    expect(text, contains('ReferenceFile: three.arw'));
    expect(text, contains('OutputFormat: Linear DNG'));
    expect(text, contains('#0 Work247.syntheticExport'));
    expect(report.stackTrace, stackTrace.toString());
  });
}
