# Work299 Native streamed RAW decode

## Confirmed pre-change bottleneck
The production LibRaw adapter allocated a full `float[pixel_count]` plane after `LibRaw::unpack()` and copied every 16-bit sensor sample into it before Dart could begin calibration. For a 60 MP frame this allocation alone is about 240 MB.

## Change
- Added optional ABI-v1 capability `MOBILE_STACK_RAW_CAPABILITY_DECODE_TO_FILE`.
- Added `mobile_stack_raw_decode_to_file(...)`.
- The LibRaw implementation now converts one sensor row at a time into a temporary FP32 row buffer and writes it directly to the requested file.
- It does not allocate the full-frame FP32 output plane. LibRaw's own unpacked sensor storage still exists, so this does not eliminate all RAW decode memory.
- Existing `mobile_stack_raw_decode(...)` is unchanged. Work299 therefore establishes and validates the native streamed-decode primitive; the Dart production pipeline is not switched to it in this work.

## Numerical behavior
Each stored sample is still `static_cast<float>(source[column])`, identical to the existing LibRaw decode conversion. There is no calibration, demosaic, registration, stacking, or export math change in Work299.

## Validation
- Native Release configure/build: PASS.
- `mobile_stack_raw_c_contract`: PASS, including a new streamed-file conformance check verifying the exact four FP32 fixture values and `result->samples == NULL`.
- CTest: 7/8 PASS. The only failure is the same pre-existing `mobile_stack_arw_lossless` pixel-limit assertion (lines 367/457) seen in Work288-Work298.
- Flutter/Dart analyzer, APK build, and Android RSS measurement: not run in this environment.

## Next wiring step
The next work should add the Dart FFI binding and a file-backed calibration path so background workers can use this primitive for eligible LibRaw Sony/Nikon frames, with fallback to the existing decoder for unsupported/oriented cases.
