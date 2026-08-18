#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo '[1/3] Installing exact dependencies...'
npm ci
echo '[2/3] Running TypeScript and Vite build...'
npm run build
echo '[3/3] Build completed successfully. Output: dist/'
