#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p work187_logs
PKG="${1:-com.mobilestack.app}"

command -v adb >/dev/null 2>&1 || { echo "ERROR: adb not found"; exit 127; }
adb devices -l | tee work187_logs/adb-device.txt
count="$(adb devices | awk 'NR>1 && $2=="device"{c++} END{print c+0}')"
[[ "$count" -eq 1 ]] || { echo "ERROR: exactly one authorized device required; found $count"; exit 2; }

echo "Start a real highest-quality stack with >=2 RAW files on the device."
read -r -p "Press Enter after the stack is visibly RUNNING... "

adb shell dumpsys jobscheduler | grep -i -A 30 -B 10 mobilestack \
  | tee work187_logs/adb-workmanager-before.txt || true

echo "Put the app in BACKGROUND with Home. Do NOT force-stop."
read -r -p "Press Enter when backgrounded... "
adb shell am kill "$PKG"
sleep 3

adb shell dumpsys jobscheduler | grep -i -A 30 -B 10 mobilestack \
  | tee work187_logs/adb-workmanager-after-kill.txt || true

echo "Relaunch from launcher; verify recovery and no duplicate job."
read -r -p "Press Enter after relaunch/recovery inspection... "

adb shell dumpsys jobscheduler | grep -i -A 30 -B 10 mobilestack \
  | tee work187_logs/adb-workmanager-after-relaunch.txt || true
adb shell dumpsys package "$PKG" > work187_logs/adb-package.txt || true

echo "Evidence captured. force-stop is a separate test and must not be treated as process death."
