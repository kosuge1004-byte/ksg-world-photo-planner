import 'ffi_raw_native_workers_stub.dart'
    if (dart.library.io) 'ffi_raw_native_bridge.dart';
export 'ffi_raw_native_workers_stub.dart'
    if (dart.library.io) 'ffi_raw_native_bridge.dart'
    show lowerCurrentThreadPriorityForBackgroundWork;
import 'native_raw_decoder.dart';
import 'native_raw_metadata_probe.dart';
import 'raw_decoder_registry.dart';
import 'raw_format.dart';
import 'raw_metadata_probe.dart';
import 'raw_native_contract.dart';
import 'raw_native_feature_flags.dart';

const Set<RawFormat> nativeRawAbiV1Formats = <RawFormat>{
  RawFormat.arw,
  RawFormat.cr2,
  RawFormat.cr3,
  RawFormat.dng,
  RawFormat.nef,
  RawFormat.nrw,
  RawFormat.orf,
  RawFormat.pef,
  RawFormat.raf,
  RawFormat.rw2,
};

RawDecoderRegistry createNativeRawDecoderRegistry({
  RawNativeDecodeBackend backend = const FfiRawDecodeWorker(),
}) {
  return RawDecoderRegistry(
    <NativeRawDecoder>[
      NativeRawDecoder(
        backend: backend,
        supportedFormats: nativeRawAbiV1Formats,
      ),
    ],
  );
}

const Set<RawFormat> productionSonyNikonRawFormats = <RawFormat>{
  RawFormat.arw,
  RawFormat.nef,
  RawFormat.nrw,
};

RawDecoderRegistry createProductionNativeRawDecoderRegistry({
  RawNativeDecodeBackend backend = const FfiRawDecodeWorker(),
}) {
  return RawDecoderRegistry(
    <NativeRawDecoder>[
      NativeRawDecoder(
        backend: backend,
        supportedFormats: productionSonyNikonRawFormats,
        decoderId: 'mobile-stack-native-sony-nikon-libraw-v3',
      ),
    ],
  );
}

/// Background/headless variant.
///
/// This used to call `FfiRawDecodeCurrentIsolateBackend` directly on the
/// background worker's own isolate, on the reasoning that background workers
/// already execute outside the UI isolate, so there was no need to pay for a
/// second full-frame Native→Dart copy or an extra isolate hop.
///
/// That reasoning missed something: `StandardStackBackgroundWorker`'s own
/// `JobScheduler` runs its 30-minute per-frame stall watchdog
/// (`fullFrameRawStallTimeout`) as a plain Dart `Timer` on that *same*
/// isolate. A synchronous FFI call blocks the isolate's event loop for its
/// entire duration — that's true whether or not the isolate happens to be a
/// background one — so if a single native decode call genuinely hangs (or is
/// merely extraordinarily slow, e.g. under sustained thermal throttling),
/// the watchdog `Timer` callback can never run either, since running it
/// requires the very event loop the blocking call is holding hostage. The
/// intended "convert a hang into a clear failure" safety net silently
/// disables itself in exactly the case it exists for, and the whole app
/// (not just the job) can be perceived by the OS as unresponsive (ANR)
/// instead of surfacing the friendly timeout error.
///
/// `FfiRawDecodeBackgroundWorkerBackend` keeps the decode call off the
/// isolate that hosts the watchdog `Timer` (spawning a fresh worker isolate
/// per call, same as the UI path's `FfiRawDecodeWorker`), while still
/// implementing `RawNativeFileDecodeBackend` so the streamed/file-backed
/// decode path — and its low memory footprint — keeps working for
/// background jobs. See its doc comment for why `decodeToFile` pays no
/// extra copy for this, and why `decode` (the in-memory fallback path)
/// paying one is an acceptable, non-optional trade.
RawDecoderRegistry createProductionBackgroundNativeRawDecoderRegistry() {
  return createProductionNativeRawDecoderRegistry(
    backend: const FfiRawDecodeBackgroundWorkerBackend(),
  );
}

/// Backwards-compatible name retained for integrations compiled against Work245.
RawDecoderRegistry createProductionNativeArwDecoderRegistry({
  RawNativeDecodeBackend backend = const FfiRawDecodeWorker(),
}) =>
    createProductionNativeRawDecoderRegistry(backend: backend);

RawMetadataProbe createNativeRawMetadataProbe({
  RawNativeMetadataProbeBackend backend = const FfiRawMetadataProbeWorker(),
}) {
  return NativeRawMetadataProbe(
    backend: backend,
    supportedFormats: nativeRawAbiV1Formats,
  );
}

RawMetadataProbe? createFeatureFlaggedNativeRawMetadataProbe({
  bool enabled = nativeDngMetadataEnabled,
  RawNativeMetadataProbeBackend backend = const FfiRawMetadataProbeWorker(),
}) {
  if (!enabled) return null;
  return NativeRawMetadataProbe(
    backend: backend,
    supportedFormats: const <RawFormat>{RawFormat.dng},
    probeId: 'mobile-stack-native-dng-metadata-v1',
  );
}

RawMetadataProbe createProductionNativeRawMetadataProbe({
  bool enableDngMetadata = nativeDngMetadataEnabled,
  RawNativeMetadataProbeBackend backend = const FfiRawMetadataProbeWorker(),
}) {
  return NativeRawMetadataProbe(
    backend: backend,
    supportedFormats: <RawFormat>{
      ...productionSonyNikonRawFormats,
      if (enableDngMetadata) RawFormat.dng,
    },
    probeId: 'mobile-stack-native-production-metadata-v1',
  );
}
