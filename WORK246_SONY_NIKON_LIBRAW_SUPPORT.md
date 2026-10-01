# Work246 — Sony first, Nikon next: broad sensor RAW support

## Outcome

Work245 remains the only primary Sony implementation. Work246 adds the
unmodified LibRaw 0.22.2 source as a bounded fallback for Sony ARW and as the
production sensor decoder for Nikon NEF/NRW. The public ABI stays at v1.

The production Dart registry now exposes exactly:

- Sony ARW
- Nikon NEF
- Nikon NRW

Other enum values remain available for format identification and future
decoders, but are not advertised as production pixel decoders.

## Quality contract

The LibRaw bridge calls `open_file()` and `unpack()` only. It copies the active
single-plane Bayer `ushort` sensor values to the ABI-owned FP32 plane. It does
not call LibRaw demosaic or post-processing and does not apply black subtraction,
white balance, gamma, auto-brightness, tone mapping, or resize.

The bridge validates exact file length, maker/format agreement, bounded active
geometry, row pitch, allocation sizes, 2x2 CFA phase, black/white range, and
finite color metadata. Four Bayer phase orders are supported. Non-Bayer and
multi-plane/pseudo-RAW inputs are rejected.

Sony always tries the Work245 decoder first. When that path decodes a newer
camera but has no model-specific D65 matrix, LibRaw supplements only the color
matrix; Work245 geometry, levels, WB, and sensor decode ownership are retained.

## Native ABI evidence

The Android x86_64 emulator executed `mobile_stack_raw_probe_cli` against
hash-pinned CC0 files from raw.pixls.us. Every verified row met all of these:

- decode status and metadata status are zero;
- `sampleCount == width * height`;
- all copied FP32 values are finite;
- a valid D65 XYZ-to-camera matrix is present;
- deterministic FNV-1a of the FP32 byte plane was recorded.

Verified Sony rows:

- A7 III: full-frame compressed 14-bit
- A7 IV: full-frame uncompressed 14-bit
- A7 IV: full-frame lossless Large 14-bit
- A7 IV: full-frame compressed 14-bit
- A7 IV: APS-C compressed 14-bit

Verified Nikon rows:

- D750: compressed 12-bit and lossless compressed 14-bit
- D800: uncompressed 12-bit and compressed 14-bit
- Z 8: standard lossless compressed 14-bit
- COOLPIX P7000: NRW 12-bit

Exact URLs, byte lengths, SHA-256 values, dimensions, levels, extrema, and
sensor-plane hashes are in `SONY_NIKON_RAW_VERIFICATION_MANIFEST.json`.

## Unsupported by design

- Sony Medium/Small YCC or pseudo-RAW is not a single-plane Bayer source. An
  A7 IV Medium sample was rejected with native status 2/error 4004.
- Nikon High Efficiency and High Efficiency* use a layout unsupported by
  LibRaw 0.22.2. A Z 8 HE sample was rejected with status 2/error 4007.
- A camera name in LibRaw's inventory is not automatically marked verified.
  The compatibility CSV retains `SAMPLE_MISSING` until an exact sample passes.

## Build and platform state

- Android NDK 28.2 / Clang 19 arm64 and x86_64 native builds: PASS
- Flutter static analysis: PASS, no issues
- Flutter tests: PASS, 807/807
- Node source/algorithm contracts: PASS, 671/671
- Android arm64 release APK including the native library: PASS
- Release APK core ABI exports: PASS, eight symbols
- iOS source/pod integration: implemented; build not run on Windows
- Physical Android/iOS device validation: not run in this work

LibRaw upstream license files are vendored unchanged. This distribution selects
the CDDL 1.0 option; see `native/THIRD_PARTY_NOTICES.md`.
