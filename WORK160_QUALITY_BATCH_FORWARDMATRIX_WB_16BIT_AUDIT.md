# Work160 Quality Batch — ForwardMatrix / White Balance / 16-bit Audit

Status: WIP. Work159 (`0.8.5+159`) remains the last fully Flutter-validated release.

## Implemented

- Fixed `AsShotWhiteXY` white-balance reconstruction when a DNG ForwardMatrix is active.
  - CameraNeutral is now derived from the selected-white `XYZtoCamera = AB * CC * CM` transform.
  - It is no longer reconstructed from the published D50-referenced inverse ForwardMatrix using a D65 vector.
  - This prevents a ForwardMatrix-only white-balance color error on DNGs that provide `AsShotWhiteXY` without `AsShotNeutral`.
- Added compact native regression fixtures for:
  - single ForwardMatrix + `AsShotWhiteXY`,
  - dual-illuminant ForwardMatrix profiles,
  - triple-illuminant ForwardMatrix profiles,
  - invalid triple calibration with only two of the three required ForwardMatrix tags.
- Triple ForwardMatrix completeness is verified: all three ForwardMatrix tags are required when the third calibration is present.

## 16-bit output audit

- Reviewed the TIFF16 export path from floating-point tone mapping through final integer encoding.
- The current design remains display-referred 16-bit sRGB with the standard sRGB ICC profile.
- No intermediate 8-bit conversion or additional quantization step was found in the audited TIFF16 path.
- No speculative change was made to `HintMaxOutputValue`, white point, or to convert the TIFF output to linear data. Those changes would alter the established output contract without a specification-backed reason.

## Executed validation available in this environment

- Native C/CMake build: PASS.
- Native CTest: 8/8 PASS.
- Node reference/regression suite: 42 files, 365/365 PASS.
- Flutter/Dart tests, `dart analyze`, and APK build: NOT RUN because the SDK/toolchain is unavailable in this environment.

## Release state

- Version intentionally remains `0.8.5+159`.
- Work160 remains WIP until Flutter/Dart validation can be run.
