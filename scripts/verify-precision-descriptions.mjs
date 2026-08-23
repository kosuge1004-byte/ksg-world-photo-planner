import fs from "node:fs";

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function requireText(source, expected, message) {
  if (!source.includes(expected)) throw new Error(message);
}

const settings = read("src/components/TopSettingsBar.tsx");
const styles = read("src/App.css");
const precisionTypes = read("src/types/precision.ts");

for (const [expected, label] of [
  ["Google Photorealistic 3D Tilesを使用しません", "standard mode"],
  ["遮蔽判定・最終確認は標準モードと同じくDEM地形のみ", "highest mode"],
  ["DEM（地形の高さデータ）", "DEM"],
  ["PLATEAU（建物を含む立体データ、オープンデータ）", "PLATEAU height"],
  ["利用できる天気データで空気による光の曲がりを補正します", "automatic refraction"],
  ["一般的な気温・気圧を使って補正します", "standard refraction"],
]) {
  requireText(settings, expected, `${label} explanation is missing`);
}

// 「補正なし」は、pro固定のメイン計算経路では実際には屈折を無効化できて
// いなかった（標準大気差へ無条件フォールバックしていた）ため廃止した。
// 表示と実計算が食い違う設定を復活させないためのガード。
if (settings.includes('"none"') && /RefractionCorrectionMode/.test(settings)) {
  throw new Error("removed 'no refraction' option must not be reintroduced into RefractionCorrectionMode");
}

requireText(styles, "max-height: calc(100dvh", "precision menu is not height bounded");
requireText(styles, "overflow-y: auto", "precision menu is not vertically scrollable");
requireText(
  styles,
  ".calculation-mode-menu.precision-open",
  "expanded precision menu has no readable mobile width"
);
requireText(
  styles,
  "min-height: 48px",
  "precision choices do not preserve a touch-friendly target"
);

for (const expected of [
  'accuracyMode: "standard"',
  'refractionCorrectionMode: "auto"',
]) {
  requireText(precisionTypes, expected, `default setting changed or missing: ${expected}`);
}

console.log("Precision setting descriptions and defaults verification: PASS");
