#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <native-artifact> [nm-tool]" >&2
  exit 64
fi

artifact="$1"
nm_tool="${2:-nm}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "${script_dir}/.." && pwd)"
required_manifest="${project_dir}/native/abi/v1_required_symbols.txt"
metadata_manifest="${project_dir}/native/abi/v1_metadata_symbols.txt"
demosaic_manifest="${project_dir}/native/abi/demosaic_v1_symbols.txt"

if [[ ! -f "${artifact}" ]]; then
  echo "native artifact not found: ${artifact}" >&2
  exit 66
fi
if [[ ! -x "${nm_tool}" ]] && ! command -v "${nm_tool}" >/dev/null 2>&1; then
  echo "nm tool not found: ${nm_tool}" >&2
  exit 69
fi

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT
raw_symbols="${temp_dir}/raw.txt"
actual_symbols="${temp_dir}/actual.txt"
expected_symbols="${temp_dir}/expected.txt"

if [[ "$(uname -s)" == "Darwin" ]]; then
  "${nm_tool}" -gU "${artifact}" >"${raw_symbols}"
else
  "${nm_tool}" -D --defined-only "${artifact}" >"${raw_symbols}"
fi

awk '{print $NF}' "${raw_symbols}" |
  sed 's/^_//' |
  grep -E '^mobile_stack_(raw|demosaic)_' |
  LC_ALL=C sort -u >"${actual_symbols}" || true

cat "${required_manifest}" "${metadata_manifest}" "${demosaic_manifest}" |
  sed '/^[[:space:]]*$/d' |
  LC_ALL=C sort -u >"${expected_symbols}"

missing="$(comm -23 "${expected_symbols}" "${actual_symbols}")"
unexpected="$(comm -13 "${expected_symbols}" "${actual_symbols}")"
if [[ -n "${missing}" ]]; then
  echo "missing Mobile Stack RAW exports:" >&2
  echo "${missing}" >&2
  exit 1
fi
if [[ -n "${unexpected}" ]]; then
  echo "unexpected Mobile Stack RAW exports:" >&2
  echo "${unexpected}" >&2
  exit 1
fi

echo "verified $(wc -l <"${expected_symbols}" | tr -d ' ') native ABI exports"
