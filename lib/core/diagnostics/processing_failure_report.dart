import 'package:path/path.dart' as p;

import '../export/output_image_format.dart';
import '../io/raw_input_contract.dart';
import '../models/processing_mode.dart';
import '../raw/raw_decoder_contract.dart';
import '../raw/raw_format.dart';

typedef ProcessingStageReporter = void Function(
    ProcessingFailureStage stage, String? substage);

enum ProcessingFailureStage {
  rawInputValidation('RAW入力確認'),
  rawMetadata('RAWメタデータ解析'),
  nativeRawDecode('ネイティブRAWデコード'),
  blackWhiteLevel('黒/白レベル処理'),
  whiteBalanceProfile('WB/カメラ色プロファイル準備'),
  demosaic('デモザイク'),
  rgbTileGeneration('RGBタイル生成'),
  referenceFramePreparation('基準フレーム準備'),
  starDetection('星検出'),
  referenceAlignmentPreparation('基準フレーム位置合わせ準備'),
  frameAlignment('フレーム位置合わせ'),
  stackCombination('スタック合成'),
  foregroundProcessing('foreground処理'),
  finalRenderProfileValidation('最終レンダープロファイル検証'),
  outputFilePreparation('出力ファイル準備'),
  linearDngExport('Linear DNG書き出し'),
  tiffExport('TIFF書き出し'),
  jpegExport('JPEG書き出し'),
  bmpExport('BMP書き出し'),
  temporaryFileProcessing('一時ファイル処理'),
  resultHandoff('結果画面への引き渡し'),
  unknown('不明');

  const ProcessingFailureStage(this.label);
  final String label;

  static ProcessingFailureStage forOutput(OutputImageFormat format) {
    return switch (format) {
      OutputImageFormat.linearDng => ProcessingFailureStage.linearDngExport,
      OutputImageFormat.tiff16 => ProcessingFailureStage.tiffExport,
      OutputImageFormat.jpeg => ProcessingFailureStage.jpegExport,
      OutputImageFormat.bmp8 => ProcessingFailureStage.bmpExport,
    };
  }

  static ProcessingFailureStage fromJobLabel(String? label) {
    final String value = label ?? '';
    if (value.contains('メタデータ')) return rawMetadata;
    if (value.contains('ネイティブRAW') || value.contains('RAW展開')) {
      return nativeRawDecode;
    }
    if (value.contains('ブラック') ||
        value.contains('ホワイトレベル') ||
        value.contains('線形化')) {
      return blackWhiteLevel;
    }
    if (value.contains('ホワイトバランス') || value.contains('色プロファイル')) {
      return whiteBalanceProfile;
    }
    if (value.contains('デモザイク')) return demosaic;
    if (value.contains('タイル')) return rgbTileGeneration;
    if (value.contains('入力') || value.contains('検証')) return rawInputValidation;
    return unknown;
  }
}

/// Immutable, shareable diagnostics for both RAW-job and downstream failures.
/// Unknown fields stay null and are rendered explicitly as "not available".
final class ProcessingFailureReport {
  ProcessingFailureReport({
    required this.timestamp,
    required this.mode,
    required this.stage,
    required this.exceptionType,
    required this.message,
    required this.stackTrace,
    required List<String> inputFiles,
    required this.inputCount,
    required this.outputFormat,
    required this.completedJobs,
    required this.failedJobs,
    required this.cancelled,
    this.substage,
    this.targetRawFile,
    this.referenceFile,
    this.referenceIndex,
    this.rawFormat,
    this.cameraMake,
    this.cameraModel,
    this.dimensions,
    this.cfa,
    this.bitDepth,
    this.rawCompression,
    this.nativeErrorCode,
    this.nativeErrorMessage,
    this.lastCompletedStage,
  }) : inputFiles = List<String>.unmodifiable(inputFiles);

  factory ProcessingFailureReport.capture({
    required Object error,
    required StackTrace stackTrace,
    required ProcessingMode mode,
    required ProcessingFailureStage stage,
    required List<RawInputFile> inputs,
    required OutputImageFormat outputFormat,
    required int completedJobs,
    required int failedJobs,
    required bool cancelled,
    String? substage,
    RawInputFile? target,
    RawInputFile? reference,
    int? referenceIndex,
    ProcessingFailureStage? lastCompletedStage,
  }) {
    final RawDecodeFailure? nativeFailure =
        error is RawDecodeFailure ? error : null;
    final RawInputFile? metadataSource = target ?? reference;
    return ProcessingFailureReport(
      timestamp: DateTime.now(),
      mode: mode,
      stage: stage,
      substage: substage,
      exceptionType: error.runtimeType.toString(),
      message: error.toString(),
      stackTrace: stackTrace.toString(),
      targetRawFile: target?.name,
      inputFiles: <String>[for (final RawInputFile file in inputs) file.name],
      inputCount: inputs.length,
      referenceFile: reference?.name,
      referenceIndex: referenceIndex,
      rawFormat: metadataSource?.probe?.format.label,
      dimensions: metadataSource?.metadata == null
          ? null
          : '${metadataSource!.metadata!.width}x'
              '${metadataSource.metadata!.height}',
      cfa: metadataSource?.metadata?.cfaPattern.name.toUpperCase(),
      outputFormat: outputFormat.label,
      completedJobs: completedJobs,
      failedJobs: failedJobs,
      cancelled: cancelled,
      nativeErrorCode:
          nativeFailure?.nativeCode?.toString() ?? nativeFailure?.code.name,
      nativeErrorMessage: nativeFailure?.message,
      lastCompletedStage: lastCompletedStage,
    );
  }

  final DateTime timestamp;
  final ProcessingMode mode;
  final ProcessingFailureStage stage;
  final String? substage;
  final String exceptionType;
  final String message;
  final String stackTrace;
  final String? targetRawFile;
  final List<String> inputFiles;
  final int inputCount;
  final String? referenceFile;
  final int? referenceIndex;
  final String? rawFormat;
  final String? cameraMake;
  final String? cameraModel;
  final String? dimensions;
  final String? cfa;
  final String? bitDepth;
  final String? rawCompression;
  final String outputFormat;
  final int completedJobs;
  final int failedJobs;
  final bool cancelled;
  final String? nativeErrorCode;
  final String? nativeErrorMessage;
  final ProcessingFailureStage? lastCompletedStage;

  String toPlainText() {
    String available(Object? value) => value?.toString() ?? 'not available';
    final Duration zone = timestamp.timeZoneOffset;
    final String zoneSign = zone.isNegative ? '-' : '+';
    final int zoneMinutes = zone.inMinutes.abs();
    final String zoneText = '$zoneSign'
        '${(zoneMinutes ~/ 60).toString().padLeft(2, '0')}:'
        '${(zoneMinutes % 60).toString().padLeft(2, '0')}';
    final StringBuffer out = StringBuffer()
      ..writeln('Mobile Stack Error Report')
      ..writeln('App/Work: Work247')
      ..writeln('Timestamp: ${timestamp.toIso8601String()} $zoneText')
      ..writeln('Mode: ${mode.label}')
      ..writeln('Stage: ${stage.label}')
      ..writeln('Substage: ${available(substage)}')
      ..writeln('LastCompletedStage: ${available(lastCompletedStage?.label)}')
      ..writeln()
      ..writeln('ExceptionType: $exceptionType')
      ..writeln('Message: $message')
      ..writeln()
      ..writeln('TargetRawFile: ${available(targetRawFile)}')
      ..writeln('CameraMake: ${available(cameraMake)}')
      ..writeln('CameraModel: ${available(cameraModel)}')
      ..writeln('RawFormat: ${available(rawFormat)}')
      ..writeln('RawCompression: ${available(rawCompression)}')
      ..writeln('BitDepth: ${available(bitDepth)}')
      ..writeln('Dimensions: ${available(dimensions)}')
      ..writeln('CFA: ${available(cfa)}')
      ..writeln()
      ..writeln('InputFrames: $inputCount')
      ..writeln('CompletedJobs: $completedJobs')
      ..writeln('FailedJobs: $failedJobs')
      ..writeln('Cancelled: $cancelled')
      ..writeln('ReferenceIndex: ${available(referenceIndex)}')
      ..writeln('ReferenceFile: ${available(referenceFile)}')
      ..writeln('OutputFormat: $outputFormat')
      ..writeln()
      ..writeln('Files:');
    for (int index = 0; index < inputFiles.length; index++) {
      out.writeln('${index + 1}. ${p.basename(inputFiles[index])}');
    }
    out
      ..writeln()
      ..writeln('NativeErrorCode: ${available(nativeErrorCode)}')
      ..writeln('NativeErrorMessage: ${available(nativeErrorMessage)}')
      ..writeln()
      ..writeln('StackTrace:')
      ..write(stackTrace.isEmpty ? 'not available' : stackTrace);
    return out.toString();
  }
}
