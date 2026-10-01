# Work228 — CI Node regression completeness

## Finding
GitHub Actions `.github/workflows/native-raw-abi.yml` executed only 8 explicitly listed Node tests, while local `tool/work187_codex_preflight.sh` dynamically discovered every `tool/**/*.test.mjs` test. At Work227 there were 113 Node test files / 616 tests, so most source-contract and quality regression checks—including the Work227 handoff BaselineExposure contract—were not enforced by GitHub CI.

## Fix
- Added `tool/run_all_node_tests.sh` as the single shared Node regression runner.
- The runner dynamically discovers every `tool/**/*.test.mjs` file, sorts the list, fails if none exist, and runs all of them with `node --test`.
- Updated `.github/workflows/native-raw-abi.yml` to call the shared runner.
- Updated `tool/work187_codex_preflight.sh` to call the same shared runner.
- Added `tool/raw_samples/test/ci_node_regression_discovery_contract.test.mjs` so CI/preflight cannot silently return to a partial hand-maintained list.

## Quality impact
No image-processing production math changed. RAW decode, calibration, demosaic, registration, local registration, focus measurement/blending, robust combine, CFA Drizzle, reconstruction, and Linear DNG pixel generation are unchanged.

## Verification in this environment
- Node test files: 114
- Node tests: 618/618 PASS
- Native Release CTest: 8/8 PASS
- Native host ABI exports: 10/10 PASS
- ASan/UBSan CTest: 8/8 PASS
- `bash -n tool/run_all_node_tests.sh tool/work187_codex_preflight.sh`: PASS

Not run here because unavailable:
- Flutter/Dart analyze and unit tests
- Android APK build / Android ABI extraction
- Pixel 9 Pro real-device tests
- Adobe readback of newly generated DNG
