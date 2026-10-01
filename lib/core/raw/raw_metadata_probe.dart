import '../image/cfa_pattern.dart';
import 'raw_decoder_contract.dart';
import 'raw_format.dart';
import 'raw_probe_result.dart';

/// フル画素デコードを行わずに取得したRAWの構造情報。
class RawMetadataProbeResult {
  const RawMetadataProbeResult({
    required this.width,
    required this.height,
    required this.cfaPattern,
    required this.metadata,
    required this.probeId,
  });

  final int width;
  final int height;
  final CfaPattern cfaPattern;
  final RawFrameMetadata metadata;
  final String probeId;
}

abstract interface class RawMetadataProbe {
  bool supports(RawFormat format);

  Future<RawMetadataProbeResult> probe(RawProbeResult source);
}
