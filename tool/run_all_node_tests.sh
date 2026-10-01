#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mapfile -d '' node_tests < <(find tool -type f -name '*.test.mjs' -print0 | sort -z)
if [[ "${#node_tests[@]}" -eq 0 ]]; then
  echo "ERROR: no Node .test.mjs files found under tool/" >&2
  exit 3
fi

printf 'Running %d Node test files\n' "${#node_tests[@]}"
printf '%s\n' "${node_tests[@]}"
node --test "${node_tests[@]}"
