// 度分秒(DMS)→10進数の変換専用ツール。
// これ以降、山座標の変換は必ずこれを通す（暗算は禁止）。
// 使い方: node dms-convert.mjs "36 45 54.20" "139 29 27.30"
const [latStr, lonStr] = process.argv.slice(2);

function parse(str) {
  const [d, m, s] = str.trim().split(/\s+/).map(Number);
  return d + m / 60 + s / 3600;
}

const lat = parse(latStr);
const lon = parse(lonStr);
console.log(`latitude: ${lat}`);
console.log(`longitude: ${lon}`);
