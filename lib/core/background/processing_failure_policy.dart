import 'dart:io';
import '../raw/raw_decoder_contract.dart';

enum ProcessingFailureDisposition { permanent, resourcePause, retry }

final class ProcessingResourcePause implements Exception {
  const ProcessingResourcePause(this.message);
  final String message;
  @override
  String toString() => message;
}

ProcessingFailureDisposition classifyProcessingFailure(Object error) {
  if (error is ProcessingResourcePause) {
    return ProcessingFailureDisposition.resourcePause;
  }
  if (error is FileSystemException) {
    // ENOSPC/ENOMEM and their Windows diagnostic equivalents.
    if (<int>{12, 28, 112, 1450}.contains(error.osError?.errorCode)) {
      return ProcessingFailureDisposition.resourcePause;
    }
    if (<int>{2, 13}.contains(error.osError?.errorCode)) {
      return ProcessingFailureDisposition.permanent;
    }
  }
  if (error is RawDecodeFailure) {
    if (<RawDecodeErrorCode>{
      RawDecodeErrorCode.outOfMemory,
      RawDecodeErrorCode.resourceLimit
    }.contains(error.code)) {
      return ProcessingFailureDisposition.resourcePause;
    }
    if (<RawDecodeErrorCode>{
      RawDecodeErrorCode.invalidArgument,
      RawDecodeErrorCode.unsupportedFormat,
      RawDecodeErrorCode.corruptData,
      RawDecodeErrorCode.abiMismatch
    }.contains(error.code)) {
      return ProcessingFailureDisposition.permanent;
    }
  }
  if (error is ArgumentError) return ProcessingFailureDisposition.permanent;
  return ProcessingFailureDisposition.retry;
}
