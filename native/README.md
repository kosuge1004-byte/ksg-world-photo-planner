# Mobile Stack Native RAW ABI v1

This product includes DNG technology under license by Adobe.

`include/mobile_stack_raw_ffi.h` is the stable C boundary between Flutter/Dart
and the Android/iOS RAW decoder implementation.

## Ownership

- The caller owns the UTF-8 path and request structure for the duration of
  `mobile_stack_raw_decode`.
- The native decoder owns `MobileStackRawDecodeResult`, `samples`, and
  `error_message`.
- The caller must release every non-null result exactly once with
  `mobile_stack_raw_decode_result_release`, including failed results.
- Metadata results and their error messages are owned by native code and must
  be released exactly once with `mobile_stack_raw_metadata_result_release`.
- Dart copies `samples` into a Dart-owned `Float32List` before releasing the
  result. Native pointers never leave the synchronous FFI call.

## ABI v1 invariants

- `abi_version` must equal `MOBILE_STACK_RAW_ABI_VERSION`.
- Both sides verify `struct_size` before reading optional/result fields.
- `samples` is tightly packed, row-major, one FP32 sensor sample per pixel.
- `sample_count` equals `width * height`.
- `row_stride_samples` equals `width`.
- CFA patterns are limited to RGGB, BGGR, GRBG, and GBRG.
- Orientation follows EXIF values 1 through 8.
- Sensor values are preserved. The native decoder must not apply gamma,
  auto-brightening, white balance, black-level subtraction, denoising,
  demosaicing, scaling, or lossy precision conversion.
- `expected_byte_length`, expected format, and `maximum_pixel_count` are hard
  validation limits. The decoder must fail instead of downsampling.
- Error messages are UTF-8 byte sequences with an explicit length.

## Optional metadata extension

The ABI number remains 1. A caller first resolves
`mobile_stack_raw_capabilities` dynamically. It may call the metadata
extension only when `MOBILE_STACK_RAW_CAPABILITY_METADATA_PROBE` is set and
both `mobile_stack_raw_probe_metadata` and
`mobile_stack_raw_metadata_result_release` are present.

This preserves compatibility with older ABI v1 libraries that export only the
five original decode symbols. Such libraries are treated as decode-capable and
metadata-probe-unavailable.

The metadata result contains image dimensions, CFA, active area, orientation,
black levels, white level, and optional camera white balance. It has no sample
buffer, so the probe cannot return a decoded full-resolution mosaic.

## Execution model

The synchronous C call is opened and executed inside `Isolate.run`. The worker
copies the result to Dart-owned memory, releases the native result and decoder
context, then transfers the Dart object graph back as the isolate exits.
Production full-frame RAW jobs use one scheduler lane, and the default caller
limit is 64,000,000 pixels. This prevents a second retained FP32 CFA from
overlapping the first job's quality pipeline. At the limit, the native and
Dart FP32 buffers can briefly total about 512 MB during the ownership copy.

Android will load `libmobile_stack_raw.so`. iOS will resolve the exported
symbols from the current process after the native library is statically linked.

## Conformance, DNG metadata, and Sony ARW backend

`src/mobile_stack_raw_ffi_stub.c` implements the ownership/error contract and
dispatches the bounded production Sony ARW path.

- `mobile-stack-abi://success` with expected byte length 4 returns a
  deterministic 2x2 RGGB FP32 mosaic.
- `mobile-stack-abi://metadata` with expected byte length 4 returns
  deterministic 6000x4000 RGGB metadata without allocating samples.
- A pixel limit below 4 returns `MOBILE_STACK_RAW_RESOURCE_LIMIT`.
- A matching Sony ARW ordinary path is dispatched to
  `src/mobile_stack_arw_lossless.c`.
- Other ordinary paths return `MOBILE_STACK_RAW_UNSUPPORTED_FORMAT`.
- Every non-null result owns its sample and error buffers and must be released.

When `MOBILE_STACK_RAW_ENABLE_DNG_METADATA=1`,
`src/mobile_stack_dng_metadata.c` probes a real classic TIFF/DNG file without
reading pixel strips or allocating a full-file buffer. The production
capability is advertised separately as
`MOBILE_STACK_RAW_CAPABILITY_DNG_METADATA`.

The parser accepts little- and big-endian classic TIFF, follows bounded
IFD/SubIFD trees, selects the largest full-size 2x2 Bayer CFA IFD, and reads
dimensions, ActiveArea, Orientation, BlackLevel, WhiteLevel, and
AsShotNeutral. It validates the caller-supplied byte length and every external
value offset. Limits are 16 IFDs, 512 entries per IFD, 8 SubIFDs per IFD, and
64 BlackLevel values. BigTIFF, non-Bayer CFA, and pixel decoding are outside
this backend.

`src/mobile_stack_arw_lossless.c` accepts classic-TIFF 2x2 RGGB CFA sensor
IFDs in three Sony layouts. Tiled input may contain no more than 4096 tiles;
each tile must be at most 8 MiB and contain a four-component JPEG Lossless
SOF3 scan with unit sampling,
predictor 1, zero point transform, and no restart interval. The decoder
validates canonical DC Huffman tables, entropy byte stuffing, prediction
bounds, padding, EOI, caller byte length, and caller pixel limit. Components
are restored to their 2x2 CFA locations and copied to tightly packed FP32
without level correction, white balance, or demosaicing. Uncompressed Compression=1 CFA strips are accepted when samples are stored as endian-aware 16-bit words and the strip byte count is exactly two bytes per pixel. Values are range-checked against BitsPerSample. Sony ARW2 compression
32767 is accepted only for little-endian 12-bit CFA strips whose width is a
multiple of 16 and whose byte count is exactly one byte per pixel. Every
16-byte block is bounds-checked, decoded from its two 11-bit extrema and
fourteen 7-bit adaptive residuals, and expanded to the camera's 14-bit sensor
scale.

The ARW capabilities are advertised as
`MOBILE_STACK_RAW_CAPABILITY_ARW_LOSSLESS_JPEG` and
`MOBILE_STACK_RAW_CAPABILITY_SONY_ARW2`. Other Sony compression layouts are
rejected. If Sony `WB_RGGBLevels` tag `0x7313` is present as four
positive signed SHORT values, the decoder returns those multipliers normalized
against the mean of the two green channels. The metadata does not alter sensor
samples.

Android compiles all four sources as `libmobile_stack_raw.so` through CMake.
iOS builds them as the local static `MobileStackRaw` Pod. AppDelegate makes a
direct RAW- and demosaic-version call so their object files cannot be omitted
from the final image by static archive dead stripping.

## ABI checks and corpus CLI

The host CMake project builds five C11 test executables and the
`mobile_stack_dng_probe_cli` diagnostic executable. CTest registers six
checks:

- `mobile_stack_raw_abi_layout_test` fixes structure sizes and field offsets.
- `mobile_stack_raw_c_contract_test` exercises decode, metadata, ownership,
  capabilities, a real minimal DNG, byte-length mismatch, IFD resource limits,
  and ordinary decode-path rejection through the public C API.
- `mobile_stack_dng_hardening_test` exercises little- and big-endian inline
  values, IFD0-to-SubIFD traversal, invalid external offsets, the 16-IFD
  resource limit, and 128 repeated probe/release cycles.
- `mobile_stack_dng_cli_contract` generates a synthetic DNG, invokes the real
  CLI, parses its JSON with CMake, and fixes all expected fields.
- `mobile_stack_arw_lossless_test` generates tiled SOF3 and stripped ARW2
  files and checks full CFA decoding, ARW2 scale expansion, normalized Sony
  camera WB metadata, pixel limits, byte-length mismatch, and predictor
  rejection through the public ABI.
- `mobile_stack_demosaic_test` checks independent adaptive tile math, native
  sample preservation, mirrored borders, exact split-tile equivalence,
  published radius-4 overlap validation, gated chroma-speckle suppression,
  point-source protection, advanced diagonal-edge quality, cancellation,
  unsupported CFA, and non-finite failure.

The CLI accepts exactly one DNG path, obtains its exact byte length, calls only
the public ABI, and emits one versioned JSON object. It is a host verification
tool and is not compiled into the Android or iOS application.

`tool/dng_corpus/verify_dng_corpus.mjs` validates private or separately
licensed real-camera corpora. It requires provenance, license and
redistribution status, reference-tool details, exact size, SHA-256, and
expected metadata. Hashing is streamed and the native process is launched
without a shell. The verifier supports bounded parallel and repeated probes,
keeps logs and report runs in deterministic order, and can atomically publish a
versioned JSON report only after every run passes. Existing reports are never
overwritten. Every native process has a bounded timeout; the first timeout,
process failure, or metadata mismatch stops scheduling and cancels active
probes. Caller cancellation, Ctrl+C, and `SIGTERM` propagate through streamed
hashing and active native processes and cannot publish a final report.

`tool/dng_corpus/inventory_dng_corpus.mjs` prepares a non-verifiable draft
inventory before manifest authoring. It recursively enumerates regular `.dng`
files without following symlinks, streams hashes, detects mutation during
hashing, and atomically records relative paths, byte lengths, digests, and safe
ID suggestions. It never invents provenance, license terms, reference output,
or expected metadata.

`tool/dng_corpus/create_manifest_draft.mjs` strictly revalidates that
inventory, pins the SHA-256 of its exact bytes, and creates a separate
incomplete authoring document. Provenance, reference, and expected metadata
blocks remain `null` until a person reviews and fills them. The verifier never
accepts this draft contract as a finished manifest.

`tool/dng_corpus/finalize_manifest.mjs` is the only automated promotion gate.
It requires all review blocks to satisfy the strict manifest contract, matches
mechanical fields and exact inventory bytes, rejects symlink path components,
and rehashes every current DNG before atomically creating a non-overwriting
manifest. It does not claim that manually entered evidence is truthful.

`tool/raw_samples/probe_tiff_raw.mjs` provides host-side evidence for
user-owned classic-TIFF RAW files such as Sony ARW. It streams the source
SHA-256, walks bounded IFD/SubIFD/Exif links, validates every range, and hashes
only the deterministically selected embedded JPEG (maximum 8 MiB). It emits no
source path or image bytes, does not modify or copy the RAW, and is not a
sensor-pixel decoder.

`tool/raw_samples/decode_arw_lossless_reference.mjs` independently validates
the supported tiled JPEG Lossless and stripped Sony ARW2 sensor contracts and
computes a deterministic SHA-256 over the decoded row-major little-endian
uint16 CFA. It writes no decoded image. Its synthetic JPEG/ARW2, pixel-limit,
and unsupported-predictor tests run in CI.

`tool/raw_samples/raw_calibration_reference.mjs` independently checks the
application-side black subtraction, DNG-compatible white normalization, and
optional CFA white-balance math. It preserves early negative and overrange
values and writes no image data.

`tool/raw_samples/raw_defect_pixel_reference.mjs` checks explicit point-defect
correction independently from Dart. It excludes every listed defect, samples
only the same CFA phase, chooses the smallest-gradient opposing pair, and
uses a same-phase median at image boundaries. It performs no automatic
single-frame hot-pixel detection.

`abi/v1_required_symbols.txt` is the immutable five-symbol ABI v1 surface.
`abi/v1_metadata_symbols.txt` lists the three optional metadata symbols.
`abi/demosaic_v1_symbols.txt` lists the separate two-symbol demosaic v1
surface.
`tool/check_native_exports.sh` fails for either missing or unexpected
`mobile_stack_raw_*` or `mobile_stack_demosaic_*` exports.

GitHub Actions runs these checks on Linux and macOS host libraries, the arm64
library extracted from the Android APK, and the final iOS app executable.
Linux also builds and runs all host tests with AddressSanitizer and
UndefinedBehaviorSanitizer. The Dart/Android job pins Node 24 and runs the 69
dependency-free DNG-corpus, TIFF RAW probe, ARW reference-decode, linear
calibration, explicit defect-pixel, and independent adaptive-demosaic tests.
