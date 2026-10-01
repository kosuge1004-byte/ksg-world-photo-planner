# Work160 continuation – Step15

Status: WIP; application version intentionally remains `0.8.5+159` because Flutter/Dart tests and APK build are unavailable in this environment.

## Goal

Preserve image quality for DNG 1.7 HDR camera profiles by propagating `ProfileDynamicRange` end-to-end instead of treating every profile as SDR.

## Implemented

- Parse DNG tag 52551 (`ProfileDynamicRange`) in the native metadata reader.
- Validate Version=1 and DynamicRange in {0,1}; preserve `HintMaxOutputValue`.
- Keep the native FFI ABI backward-compatible by appending the new fields to the v1 result tail without moving prior fields.
- Propagate DynamicRange and HintMaxOutputValue through the Dart native bridge, `RawFrameMetadata`, same-frame metadata merge, and `DngFinalRenderProfile`.
- Enable HDR overrange mode for `ProfileHueSatMap`, `ProfileLookTable`, and `ProfileToneCurve` only when DynamicRange=1. Omitted tag remains SDR.
- Add HDR ProfileToneCurve overrange encode -> spline -> decode handling.
- Add Dart regression tests for atomic HDR propagation and HDR identity tone-curve overrange preservation (not executed here because Flutter/Dart SDK is unavailable).
- Add native DNG hardening tests for little-endian and big-endian ProfileDynamicRange and malformed DynamicRange rejection.
- Correct a stale CLI contract-test fixture byte-length expectation (242 -> 338); product code was not changed for this test-only mismatch.

## Verification available in this environment

- Native C/CMake build: PASS with project warning-as-error flags.
- Native CTest: 8/8 PASS.
- Node reference tests: 365/365 PASS.
- Independent DNG overrange encode/decode numerical round-trip at 0, 0.25, 1, 2, 4, 8, 16: PASS.
- Flutter/Dart tests, `dart analyze`, Flutter build, APK build: NOT RUN (SDK unavailable).

## Important remaining limitation

This is not a claim of complete DNG 1.7 HDR-profile support. The DNG specification also lists `RGBTables` among tags whose application changes for HDR profiles; this project does not currently implement RGBTables. Step15 only makes the already-supported HueSatMap, LookTable, and ToneCurve paths honor ProfileDynamicRange.
