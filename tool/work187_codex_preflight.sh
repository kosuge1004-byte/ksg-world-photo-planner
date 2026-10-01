#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p work187_logs
exec > >(tee work187_logs/preflight-console.txt) 2>&1

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 not found"; exit 127; }; }
for x in flutter dart java cmake ctest node unzip; do need "$x"; done

flutter --version | tee work187_logs/flutter-version.txt
java -version 2>&1 | tee work187_logs/java-version.txt

if ! flutter --version | head -n1 | grep -q 'Flutter 3\.44\.7'; then
  echo "ERROR: repository CI baseline requires Flutter 3.44.7."
  exit 2
fi

flutter clean 2>&1 | tee work187_logs/flutter-clean.txt
flutter pub get 2>&1 | tee work187_logs/pub-get.txt
flutter analyze 2>&1 | tee work187_logs/analyze.txt
flutter test 2>&1 | tee work187_logs/flutter-test.txt

flutter build apk --debug --target-platform android-arm64 \
  -PmobileStackArm64Only=true \
  --dart-define=MOBILE_STACK_ENABLE_DNG_METADATA=true \
  2>&1 | tee work187_logs/android-debug-build.txt

flutter build apk --release --target-platform android-arm64 \
  -PmobileStackArm64Only=true \
  --dart-define=MOBILE_STACK_ENABLE_DNG_METADATA=true \
  2>&1 | tee work187_logs/android-release-build.txt

mkdir -p build/abi-check/android-arm64-debug build/abi-check/android-arm64-release
unzip -p build/app/outputs/flutter-apk/app-debug.apk \
  lib/arm64-v8a/libmobile_stack_raw.so \
  > build/abi-check/android-arm64-debug/libmobile_stack_raw.so
unzip -p build/app/outputs/flutter-apk/app-release.apk \
  lib/arm64-v8a/libmobile_stack_raw.so \
  > build/abi-check/android-arm64-release/libmobile_stack_raw.so
test -s build/abi-check/android-arm64-debug/libmobile_stack_raw.so
test -s build/abi-check/android-arm64-release/libmobile_stack_raw.so
if unzip -Z1 build/app/outputs/flutter-apk/app-debug.apk | grep -Eq '^lib/(armeabi-v7a|x86|x86_64)/'; then
  echo "ERROR: non-arm64 native ABI found in debug APK"
  exit 4
fi
if unzip -Z1 build/app/outputs/flutter-apk/app-release.apk | grep -Eq '^lib/(armeabi-v7a|x86|x86_64)/'; then
  echo "ERROR: non-arm64 native ABI found in release APK"
  exit 4
fi

sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"
nm_tool="$(find "$sdk/ndk" -type f \( -name llvm-nm -o -name llvm-nm.exe \) 2>/dev/null | sort -V | tail -n1)"
test -n "$nm_tool"
bash tool/check_native_exports.sh build/abi-check/android-arm64-debug/libmobile_stack_raw.so "$nm_tool" \
  2>&1 | tee work187_logs/android-debug-abi.txt
bash tool/check_native_exports.sh build/abi-check/android-arm64-release/libmobile_stack_raw.so "$nm_tool" \
  2>&1 | tee work187_logs/android-release-abi.txt

bash tool/run_all_node_tests.sh 2>&1 | tee work187_logs/node-tests.txt
grep '^tool/.*\.test\.mjs$' work187_logs/node-tests.txt > work187_logs/node-test-inventory.txt || true

rm -rf build/work187-native-release
cmake -S native -B build/work187-native-release -DCMAKE_BUILD_TYPE=Release \
  2>&1 | tee work187_logs/native-release.txt
cmake --build build/work187-native-release --config Release --parallel \
  2>&1 | tee -a work187_logs/native-release.txt
ctest --test-dir build/work187-native-release -C Release --output-on-failure \
  2>&1 | tee -a work187_logs/native-release.txt

case "$(uname -s)" in
  Linux*) host_lib="build/work187-native-release/libmobile_stack_raw.so" ;;
  Darwin*) host_lib="build/work187-native-release/libmobile_stack_raw.dylib" ;;
  *) host_lib="" ;;
esac
if [[ -n "$host_lib" && -f "$host_lib" ]]; then
  bash tool/check_native_exports.sh "$host_lib" 2>&1 | tee work187_logs/native-host-abi.txt
fi

if [[ "$(uname -s)" == "Linux" ]]; then
  rm -rf build/work187-native-sanitized
  cmake -S native -B build/work187-native-sanitized -DCMAKE_BUILD_TYPE=Debug \
    -DMOBILE_STACK_RAW_ENABLE_SANITIZERS=ON \
    2>&1 | tee work187_logs/native-sanitized.txt
  cmake --build build/work187-native-sanitized --config Debug --parallel \
    2>&1 | tee -a work187_logs/native-sanitized.txt
  sanitizer_env=(env
    ASAN_OPTIONS=detect_leaks=1:halt_on_error=1
    UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1
  )
  if command -v gcc >/dev/null 2>&1; then
    libasan="$(gcc -print-file-name=libasan.so 2>/dev/null || true)"
    if [[ -n "$libasan" && "$libasan" != "libasan.so" && -f "$libasan" ]]; then
      sanitizer_env+=(LD_PRELOAD="$libasan")
    fi
  fi
  "${sanitizer_env[@]}" \
    ctest --test-dir build/work187-native-sanitized -C Debug --output-on-failure \
    2>&1 | tee -a work187_logs/native-sanitized.txt
else
  echo "NOT RUN: sanitizer stage is Linux-only in repository CI." | tee work187_logs/native-sanitized.txt
fi

echo "=== WORK187 PRE-FLIGHT PASS ==="
