import 'raw_decoder_contract.dart';
import 'raw_native_contract.dart';

/// Web fallback for the native RAW workers.
///
/// Keeping these types API-compatible with the FFI workers lets the UI and
/// installable PWA compile on browsers while making the unavailable decode
/// capability explicit when a user actually starts RAW processing.
final class FfiRawDecodeWorker implements RawNativeDecodeBackend {
  const FfiRawDecodeWorker({
    this.androidLibraryName = rawNativeLibraryName,
  });

  final String androidLibraryName;

  @override
  Future<RawNativeDecodedFrame> decode(RawNativeDecodeCommand command) =>
      Future<RawNativeDecodedFrame>.error(
        const RawDecoderUnavailable(
          'Native RAW decoding is unavailable in the Web/PWA build.',
        ),
      );
}

final class FfiRawDecodeCurrentIsolateBackend
    implements RawNativeDecodeBackend {
  const FfiRawDecodeCurrentIsolateBackend({
    this.androidLibraryName = rawNativeLibraryName,
  });

  final String androidLibraryName;

  @override
  Future<RawNativeDecodedFrame> decode(RawNativeDecodeCommand command) =>
      Future<RawNativeDecodedFrame>.error(
        const RawDecoderUnavailable(
          'Native RAW decoding is unavailable in the Web/PWA build.',
        ),
      );
}

final class FfiRawDecodeBackgroundWorkerBackend
    implements RawNativeDecodeBackend {
  const FfiRawDecodeBackgroundWorkerBackend({
    this.androidLibraryName = rawNativeLibraryName,
  });

  final String androidLibraryName;

  @override
  Future<RawNativeDecodedFrame> decode(RawNativeDecodeCommand command) =>
      Future<RawNativeDecodedFrame>.error(
        const RawDecoderUnavailable(
          'Native RAW decoding is unavailable in the Web/PWA build.',
        ),
      );
}

/// No-op on the Web/PWA build: there is no separate background-execution
/// engine there for this to apply to, and no equivalent OS-level thread
/// priority concept to lower. See the real implementation in
/// `ffi_raw_native_bridge.dart` for why this exists.
void lowerCurrentThreadPriorityForBackgroundWork() {}

final class FfiRawMetadataProbeWorker implements RawNativeMetadataProbeBackend {
  const FfiRawMetadataProbeWorker({
    this.androidLibraryName = rawNativeLibraryName,
  });

  final String androidLibraryName;

  @override
  Future<RawNativeMetadataFrame> probeMetadata(
    RawNativeMetadataProbeCommand command,
  ) =>
      Future<RawNativeMetadataFrame>.error(
        const RawDecoderUnavailable(
          'Native RAW metadata probing is unavailable in the Web/PWA build.',
        ),
      );
}
