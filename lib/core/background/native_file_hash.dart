import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';

import 'package:ffi/ffi.dart';

/// Work360: SHA-256 of a file computed by `libmobile_stack_raw.so`
/// (`mobile_stack_util_sha256_file`, portable C, FIPS 180-4).
///
/// Produces exactly the lowercase hex digest `package:crypto`'s sha256 does
/// (verified against known-answer vectors and `sha256sum` in
/// `native/tests/mobile_stack_util_sha256_test.c`), so every existing
/// checkpoint and receipt fingerprint remains valid. It runs in a short-lived
/// isolate so the caller's event loop (heartbeats, cancellation) keeps
/// running. Returns null whenever the native path is unavailable or fails;
/// callers then use the Dart implementation, which also reproduces the
/// original error behaviour (e.g. a missing file).
typedef _HashNative = Int32 Function(Pointer<Utf8> path, Pointer<Utf8> out);
typedef _HashDart = int Function(Pointer<Utf8> path, Pointer<Utf8> out);

Future<String?> nativeFileSha256(String path) async {
  if (!Platform.isAndroid) return null;
  try {
    return await Isolate.run(() => _nativeFileSha256Sync(path));
  } on Object {
    return null;
  }
}

String? _nativeFileSha256Sync(String path) {
  final _HashDart hash;
  try {
    hash = DynamicLibrary.open('libmobile_stack_raw.so')
        .lookupFunction<_HashNative, _HashDart>('mobile_stack_util_sha256_file');
  } on Object {
    return null;
  }
  final Pointer<Utf8> nativePath = path.toNativeUtf8();
  final Pointer<Uint8> out = calloc<Uint8>(65);
  try {
    final int status = hash(nativePath, out.cast<Utf8>());
    if (status != 0) return null;
    final String hex = out.cast<Utf8>().toDartString(length: 64);
    return RegExp(r'^[0-9a-f]{64}$').hasMatch(hex) ? hex : null;
  } finally {
    calloc.free(out);
    malloc.free(nativePath);
  }
}
