import 'raw_format.dart';

class RawProbeResult {
  const RawProbeResult({
    required this.path,
    required this.format,
    required this.byteLength,
    required this.isReadable,
    required this.signatureMatched,
    this.warning,
  });

  final String path;
  final RawFormat format;
  final int byteLength;
  final bool isReadable;
  final bool signatureMatched;
  final String? warning;

  bool get isAccepted =>
      isReadable && signatureMatched && format != RawFormat.unknown;
}
