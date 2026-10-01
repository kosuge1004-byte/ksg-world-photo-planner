# Work236 - Release build gates and blocker rebase

Date: 2026-08-25
Baseline: Work235

## Why this batch
The remaining risk is no longer only source implementation. A release build can
fail or lose required native symbols even when debug builds and unit tests pass.
The repository CI previously built Android and iOS debug variants but did not
make the corresponding release variants mandatory.

## Changes
### Android CI
- Keep arm64 debug APK build.
- Add arm64 release APK build.
- Extract `libmobile_stack_raw.so` from both APKs.
- Verify all 10 required exports in both debug and release packages.

### iOS CI
- Keep debug no-codesign build and export check.
- Add release no-codesign build and export check.

### Local preflight
- Build Android arm64 debug and release APKs.
- Extract and ABI-check the native library from both.
- Keep Flutter analyze/test, Node, native Release and sanitizer stages.

### Release blocker rebase
Added `RELEASE_GATES_CURRENT.md` so old Work224 OOM text cannot be mistaken for
current evidence. Work229-235 materially changed memory lifetime, but the old
physical OOM failure is not marked resolved until a current-baseline Pixel test
actually passes.

## Quality
No production image-processing source was changed in Work236.
No RAW, demosaic, registration, focus, blend, color, DNG or exposure behavior
was changed.

## Verification performed here
- Node 640/640 PASS.
- Native Release CTest 8/8 PASS.
- Native host exports 10/10 PASS.
- ASan/UBSan 8/8 PASS.
- `bash -n tool/work187_codex_preflight.sh` PASS.
- GitHub Actions YAML parsed successfully.
- Flutter/Android/iOS builds NOT RUN here because Flutter/Dart SDK is unavailable.
- Pixel and Adobe gates NOT RUN.
