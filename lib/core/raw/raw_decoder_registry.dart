import 'raw_decoder_contract.dart';
import 'raw_format.dart';

class RawDecoderRegistry {
  RawDecoderRegistry(Iterable<RawDecoder> decoders) {
    for (final RawDecoder decoder in decoders) {
      for (final RawFormat format in decoder.descriptor.supportedFormats) {
        if (format == RawFormat.unknown) {
          throw StateError(
            '${decoder.descriptor.decoderId}がunknown形式を登録しています。',
          );
        }
        final RawDecoder? existing = _decodersByFormat[format];
        if (existing != null) {
          throw StateError(
            '${format.label}用デコーダーが重複しています: '
            '${existing.descriptor.decoderId}, '
            '${decoder.descriptor.decoderId}',
          );
        }
        if (!decoder.supports(format)) {
          throw StateError(
            '${decoder.descriptor.decoderId}のdescriptorとsupportsが'
            '一致しません。',
          );
        }
        _decodersByFormat[format] = decoder;
      }
    }
  }

  final Map<RawFormat, RawDecoder> _decodersByFormat =
      <RawFormat, RawDecoder>{};

  RawDecoder? decoderFor(RawFormat format) => _decodersByFormat[format];

  RawDecoder requireDecoder(RawFormat format) {
    final RawDecoder? decoder = decoderFor(format);
    if (decoder == null) {
      throw RawDecoderUnavailable('${format.label}用デコーダーが登録されていません。');
    }
    return decoder;
  }
}
