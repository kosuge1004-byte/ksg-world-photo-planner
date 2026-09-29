// 登録スポットの構造物高さをDEM・ジオイドで検算する（国土地理院DEMへ接続できる環境で実行）。
//
//   npx tsx scripts/audit-landmark-structure-heights-dem.mjs [--out=report.csv]
//
// 目的: カタログの heightMeters は「登録座標のDEM地表からの頂上高さ」。公表値は
// 天守台（石垣）込み／建物のみ等で基準が異なり、さらにDEM（地表）が天守台上面を
// 地表として含む場合は二重計上になる。登録座標のDEMと、半径25〜80mの周囲DEMを比べ、
// 座標が周囲より高い台上にあるか（platformMeters）を出して要確認箇所を示す。
// 高さの差分計算はジオイドに依存しない（同一地点のN差はmm級）ため、ジオイドは
// 頂上の楕円体高(ellipsoidalTopMeters)の参考表示にだけ使う。
import { writeFileSync } from "node:fs";

import { configureServerRuntime } from "../server/cloudflareRuntime.ts";
import { lookupGsiElevations } from "../server/gsiElevation.ts";
import { lookupLocalJpgeo2024Height } from "../server/jpgeo2024Local.ts";
import { JAPAN_LANDMARKS } from "../src/data/japanLandmarks.ts";

const outOption = process.argv.find((argument) => argument.startsWith("--out="));
const outPath = outOption ? outOption.slice("--out=".length) : "LANDMARK_STRUCTURE_HEIGHT_DEM_AUDIT.csv";
const RING_RADII_METERS = [25, 50, 80];
const RING_BEARINGS = Array.from({ length: 12 }, (_, index) => index * 30);
const PLATFORM_WARNING_METERS = 3;

configureServerRuntime({});

function offset(point, bearingDegrees, distanceMeters) {
  const radians = (bearingDegrees * Math.PI) / 180;
  const north = Math.cos(radians) * distanceMeters;
  const east = Math.sin(radians) * distanceMeters;
  return {
    latitude: point.latitude + north / 111_320,
    longitude: point.longitude + east / (111_320 * Math.cos((point.latitude * Math.PI) / 180)),
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
}

const structures = JAPAN_LANDMARKS.filter((landmark) => landmark.subjectSurface === "structure");
const rows = [["name", "heightMeters", "demAtPointMeters", "demSource", "ringLow20Meters", "platformMeters",
  "orthometricTopMeters", "geoidMeters", "ellipsoidalTopMeters", "flag"]];
for (const landmark of structures) {
  const ring = RING_RADII_METERS.flatMap((radius) => RING_BEARINGS.map((bearing) => offset(landmark, bearing, radius)));
  let samples;
  try {
    samples = await lookupGsiElevations(
      [landmark, ...ring].map((point) => ({ ...point, maximumDetail: "1m", interpolationMode: "neutral" }))
    );
  } catch (error) {
    rows.push([landmark.name, landmark.heightMeters ?? "", "", "", "", "", "",
      lookupLocalJpgeo2024Height(landmark.latitude, landmark.longitude) ?? "", "",
      `DEM取得失敗: ${error instanceof Error ? error.message : String(error)}`]);
    console.warn(`${landmark.name}: DEM取得失敗`);
    continue;
  }
  const center = samples[0];
  const ringHeights = samples.slice(1).map((sample) => sample.heightMeters).filter(Number.isFinite);
  const ringLow = ringHeights.length > 0 ? percentile(ringHeights, 0.2) : null;
  const platform = Number.isFinite(center.heightMeters) && ringLow !== null ? center.heightMeters - ringLow : null;
  const geoid = lookupLocalJpgeo2024Height(landmark.latitude, landmark.longitude);
  const height = landmark.heightMeters;
  const orthometricTop = Number.isFinite(center.heightMeters) && Number.isFinite(height) ? center.heightMeters + height : null;
  const flags = [];
  if (height === null) flags.push("高さ未確認");
  if (center.heightMeters === null) flags.push("DEM欠測");
  if (platform !== null && platform >= PLATFORM_WARNING_METERS) {
    flags.push(`座標が周囲より${platform.toFixed(1)}m高い台上: 天守台込みの公表値なら二重計上の可能性`);
  }
  rows.push([landmark.name, height ?? "", center.heightMeters ?? "", center.source ?? "", ringLow ?? "",
    platform === null ? "" : platform.toFixed(2), orthometricTop === null ? "" : orthometricTop.toFixed(2),
    geoid ?? "", orthometricTop !== null && geoid !== null ? (orthometricTop + geoid).toFixed(2) : "",
    flags.join(" / ")]);
  console.log(`${landmark.name}: DEM ${center.heightMeters ?? "-"}m, 台 ${platform === null ? "-" : platform.toFixed(1)}m ${flags.join(" / ")}`);
}
const csv = rows.map((row) => row.map((cell) => {
  const text = String(cell);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}).join(",")).join("\r\n");
writeFileSync(outPath, `\ufeff${csv}\r\n`);
console.log(`wrote ${outPath} (${structures.length} structures)`);
