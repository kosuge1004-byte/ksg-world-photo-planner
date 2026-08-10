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
  ["標準3D表示と同じ計算に加え、Google Photorealistic 3D Tilesを使った建物表面・遮蔽・最終3D確認を行います", "highest mode"],
  ["DEM（地形の高さデータ）", "DEM"],
  ["Google 3D（建物を含む立体データ）", "Google 3D"],
  ["利用できる天気データで空気による光の曲がりを補正します", "automatic refraction"],
  ["一般的な気温・気圧を使って補正します", "standard refraction"],
  ["天文学上の位置を表示します", "no refraction"],
  ["被写体そのものを建物などの遮蔽物と誤判定しないため", "obstruction exclusion"],
  ["点数が多いほど円盤の縁を細かく確認できます", "edge samples"],
  ["小さい値ほど一部が隠れただけでも遮蔽物ありと判定", "occlusion threshold"],
]) {
  requireText(settings, expected, `${label} explanation is missing`);
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
  "under100m: 3",
  "from100mTo500m: 10",
  "from500mTo2km: 20",
  "over2km: 50",
  "detailedEdgeCheckEnabled: false",
  "edgeSampleCount: 8",
  "obstructedThresholdPercent: 50",
]) {
  requireText(precisionTypes, expected, `default setting changed or missing: ${expected}`);
}

console.log("Precision setting descriptions and defaults verification: PASS");
