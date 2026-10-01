# Platform build setup

## Requirements

- Flutter 3.38 or newer
- Node.js 24 for DNG corpus, TIFF RAW, and ARW lossless reference tools
- Android Studio toolchain with Java 17, Android SDK, NDK, and CMake 3.22.1
- For iOS: macOS, Xcode 15 or newer, and CocoaPods

The project uses application/bundle identifier `com.mobilestack.app`. Replace
it before store registration if another identifier has already been reserved.

## Common validation

```sh
flutter pub get
flutter analyze
flutter test
node --test \
  tool/dng_corpus/test/manifest.test.mjs \
  tool/dng_corpus/test/inventory.test.mjs \
  tool/dng_corpus/test/manifest-draft.test.mjs \
  tool/dng_corpus/test/manifest-finalize.test.mjs \
  tool/raw_samples/test/probe_tiff_raw.test.mjs \
  tool/raw_samples/test/decode_arw_lossless_reference.test.mjs \
  tool/raw_samples/test/raw_calibration_reference.test.mjs \
  tool/raw_samples/test/raw_defect_pixel_reference.test.mjs
cmake -S native -B build/native -DCMAKE_BUILD_TYPE=Release
cmake --build build/native --config Release
ctest --test-dir build/native -C Release --output-on-failure
```

Run the Linux host hardening suite with sanitizers:

```sh
cmake -S native -B build/native-sanitized \
  -DCMAKE_BUILD_TYPE=Debug \
  -DMOBILE_STACK_RAW_ENABLE_SANITIZERS=ON
cmake --build build/native-sanitized --config Debug
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
ctest --test-dir build/native-sanitized -C Debug --output-on-failure
```

For a host library, verify the exact public RAW namespace with:

```sh
bash tool/check_native_exports.sh build/native/libmobile_stack_raw.so
```

Use `build/native/libmobile_stack_raw.dylib` on macOS.

## Private DNG corpus verification

First inventory user-owned candidate files without following symlinks:

```sh
node tool/dng_corpus/inventory_dng_corpus.mjs \
  --directory /path/to/private-dng-files \
  --output /path/to/inventory.json
```

The inventory is a non-verifiable draft containing only relative paths, byte
lengths, hashes, and ID suggestions. Complete provenance, license, reference,
and expected metadata manually through an explicitly incomplete authoring
draft:

```sh
node tool/dng_corpus/create_manifest_draft.mjs \
  --inventory /path/to/inventory.json \
  --output /path/to/manifest-draft.json \
  --corpus-id mobile-stack-private-dng
```

The draft pins the exact inventory SHA-256 and leaves provenance, reference,
and expected blocks as `null`. It is not accepted by the verifier. After
manually reviewing and filling every block, finalize it against the original
inventory and current DNG files:

```sh
node tool/dng_corpus/finalize_manifest.mjs \
  --draft /path/to/manifest-draft.json \
  --inventory /path/to/inventory.json \
  --directory /path/to/private-dng-files \
  --output /path/to/manifest.json
```

The finalizer rechecks inventory identity, mechanical fields, every DNG byte
length and SHA-256, and the strict manifest contract before atomic output.
Then build the host CLI and compare that provenance-tracked corpus:

```sh
cmake -S native -B build/native -DCMAKE_BUILD_TYPE=Release
cmake --build build/native --config Release
node tool/dng_corpus/verify_dng_corpus.mjs \
  --manifest /path/to/corpus/manifest.json \
  --probe build/native/mobile_stack_dng_probe_cli \
  --jobs 4 \
  --repeat 3 \
  --timeout-ms 30000 \
  --report /path/to/reports/verification.json
```

Use the generated `.exe` path on Windows. The manifest contract and local-file
policy are documented in `tool/dng_corpus/README.md`. The optional report is
published atomically only after all runs pass and never overwrites an existing
report. A timed-out or failed probe cancels active parallel probes and never
publishes a report. Ctrl+C and `SIGTERM` also cancel hashing and active probes
without publishing a report. Real-camera RAW files are intentionally not
included in the repository.

## User-owned TIFF RAW characterization

Inspect one user-owned ARW or another classic-TIFF RAW without copying it:

```sh
node tool/raw_samples/probe_tiff_raw.mjs /path/to/sample.ARW
```

The probe opens only a regular, non-symlink file, streams its SHA-256, and
checks that the file identity did not change during the run. It traverses at
most 16 IFDs with at most 4096 entries per IFD, validates all ranges, and reads
at most one embedded JPEG of 8 MiB. JSON output contains no source path and no
image bytes. This proves only the bounded embedded-preview route; it is not a
full sensor-pixel RAW decoder. See `tool/raw_samples/README.md`.

## Sony ARW lossless sensor decode

Characterize and decode a user-owned supported Sony ARW without writing the
decoded CFA:

```sh
node tool/raw_samples/decode_arw_lossless_reference.mjs /path/to/sample.ARW
```

The reference path and Native C backend accept only a classic-TIFF sensor IFD
with 2x2 RGGB CFA, bounded tiles, four-component JPEG Lossless SOF3,
predictor 1, zero point transform, and no restart interval. The Node result
contains a deterministic SHA-256 over row-major little-endian uint16 sensor
samples. The Native ABI returns the same preserved values as tightly packed
FP32 CFA samples. Unsupported Sony layouts fail explicitly.

Host CMake builds `mobile_stack_arw_lossless_test`, which generates a synthetic
ARW, decodes it through the public ABI, and checks normalized Sony
`WB_RGGBLevels` metadata, CFA values, caller pixel limits, byte-length
mismatch, and unsupported predictor rejection. Android/iOS integration tests
exercise the same synthetic file through Dart FFI. Production RAW scheduling
uses one full-job lane and a 64MP default limit to bound overlapping FP32
buffers. Do not add a private real-camera ARW to the repository.

## Tiled linear RGB scratch

Production demosaic output must use `LinearRgbTileStore`; a full-frame
`LinearRgbImage` return path no longer exists. The validated executor creates
an exclusive directory under the operating system temporary directory and
writes row-major, host-endian, interleaved FP32 RGB through
`FileBackedLinearRgbTileStore`. Only the non-overlapped output rectangle of
each planned tile is accepted, in deterministic plan order. All tiles must
pass coordinate, dimension, length, and finite-value validation before the
store commits.

Cancellation or any processing error closes and deletes the partial file.
Normal pipeline cleanup also deletes the committed scratch file and its owned
directory. The scratch representation is process-local and must not be treated
as a portable or recoverable project format. Before physical-device release,
verify creation, random row writes, partial region reads, cancellation cleanup,
and low-disk failure behavior on both Android and iOS.

## Android

The checked-in Gradle wrapper uses Gradle 8.13. The app uses AGP 8.11.1,
Kotlin 2.2.20, Java 17, and Flutter's configured Android SDK/NDK versions.

```sh
flutter build apk --debug \
  --dart-define=MOBILE_STACK_ENABLE_DNG_METADATA=true
flutter test integration_test/raw_ffi_conformance_test.dart -d <android-device>
```

`android/app/CMakeLists.txt` builds
`native/src/mobile_stack_raw_ffi_stub.c`, the read-only DNG metadata parser,
and the Sony ARW tiled JPEG Lossless decoder as `libmobile_stack_raw.so`.

Release signing intentionally still points to the debug configuration. Add a
private keystore through `android/key.properties` before distribution; never
commit the keystore or its credentials.

## iOS

```sh
flutter pub get
cd ios
pod install
cd ..
flutter build ios --debug --no-codesign \
  --dart-define=MOBILE_STACK_ENABLE_DNG_METADATA=true
flutter test integration_test/raw_ffi_conformance_test.dart -d <ios-device>
```

The local `MobileStackRaw` Pod compiles the same C source as a static framework.
`AppDelegate.swift` calls `mobile_stack_raw_abi_version()` so the object file is
retained by the linker and Dart can resolve the exported symbols from the
current process.

Select an Apple development team and provide store icons before signing or
archiving a distributable build.

## Conformance, DNG metadata, and ARW decode behavior

- `mobile-stack-abi://success` returns a deterministic 2x2 test mosaic.
- `mobile-stack-abi://metadata` returns deterministic 6000x4000 metadata
  without a pixel buffer.
- Lowering `maximum_pixel_count` below 4 returns a resource-limit error.
- A supported tiled JPEG Lossless Sony ARW path returns full-resolution FP32
  CFA sensor samples and advertises a dedicated capability bit.
- Other ARW layouts and all other ordinary pixel paths return an explicit
  unsupported/decode error.
- A real classic TIFF/DNG path can return bounded metadata only when the
  native DNG capability is present.
- The app calls that real path only in builds with
  `--dart-define=MOBILE_STACK_ENABLE_DNG_METADATA=true`; the default is off.

The DNG metadata parser reads no pixel strips and supports neither BigTIFF nor
non-Bayer CFA. The application always passes a real, header-validated
filesystem path, so it cannot accidentally receive a synthetic conformance
frame.

## GitHub Actions

`.github/workflows/native-raw-abi.yml` runs on push, pull request, and manual
dispatch. It pins Flutter 3.44.7 and performs:

- Linux/macOS C structure-layout and public-contract tests
- Little/Big Endian, SubIFD, invalid-offset, and repeated-release hardening
- Linux AddressSanitizer and UndefinedBehaviorSanitizer runs
- Native DNG probe CLI JSON contract validation
- Node 24 corpus manifest, hashing, path-safety, bounded concurrency,
  deterministic inventory, incomplete authoring drafts, strict finalization,
  repetition, timeouts, caller cancellation, atomic-output, and comparison
  tests
- Bounded TIFF RAW/embedded-JPEG probe contract and regression tests
- Sony ARW SOF3 reference decoding, deterministic CFA hash, Native C contract,
  and Android/iOS FFI integration tests
- Exact host-library export checks
- Dart analysis and all unit tests
- Android arm64 APK build and embedded `.so` export checks
- Unsigned iOS Debug build and final executable export checks

The workflow uses read-only repository permissions and cancels an older run for
the same branch when a newer commit starts.
