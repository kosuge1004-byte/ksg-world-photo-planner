// アプリの #landmark-height-audit パネルで得たJSONをカタログへ反映する。
//   npx tsx scripts/apply-landmark-height-audit.mjs audit.json          （確認のみ）
//   npx tsx scripts/apply-landmark-height-audit.mjs audit.json --write  （書き込み）
// 採否は src/audit/landmarkHeightAudit.ts の acceptLandmarkHeightAuditResult() で機械判定する。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { acceptLandmarkHeightAuditResult } from "../src/audit/landmarkHeightAudit.ts";
import { JAPAN_LANDMARKS } from "../src/data/japanLandmarks.ts";
import { applyLandmarkHeightsToSource } from "./lib/landmarkHeightApply.mjs";

const inputPath = process.argv[2];
const write = process.argv.includes("--write");
if (!inputPath) throw new Error("usage: apply-landmark-height-audit.mjs <audit.json> [--write]");
const audit = JSON.parse(readFileSync(inputPath, "utf8"));
if (audit.schemaVersion !== 1 || !Array.isArray(audit.results)) throw new Error("unsupported audit file");

const heights = new Map();
const lines = [];
for (const result of audit.results) {
  const catalogued = JAPAN_LANDMARKS.find((landmark) => landmark.name === result.name);
  // 実測後に座標が変わった地点へ古い値を入れない。
  const decision = !catalogued ||
    Math.abs(catalogued.latitude - result.latitude) > 1e-6 || Math.abs(catalogued.longitude - result.longitude) > 1e-6
    ? { accepted: false, reason: "実測時の座標が現在のカタログと一致しない" }
    : acceptLandmarkHeightAuditResult(result);
  if (decision.accepted) heights.set(result.name, decision.heightMeters);
  const platform = Number.isFinite(result.platformMeters) ? `台${result.platformMeters.toFixed(1)}m` : "台-";
  lines.push(`| ${result.name} | ${decision.accepted ? `採用 ${decision.heightMeters}m` : `不採用: ${decision.reason}`} | ` +
    `頂上ずれ${Number.isFinite(result.topOffsetMeters) ? result.topOffsetMeters.toFixed(1) : "-"}m・${platform} |`);
}
console.log(lines.join("\n"));

const files = ["server/landmarkPrewarmSeed.ts", "src/data/japanLandmarks.ts"];
const updated = files.map((file) => {
  const { source, applied } = applyLandmarkHeightsToSource(readFileSync(file, "utf8"), heights);
  return { file, source, applied };
});
const [seed, client] = updated;
if (seed.applied.join("|") !== client.applied.join("|")) throw new Error("seed and client catalogues diverged");
console.log(`\n採用 ${client.applied.length}件 / 実測 ${audit.results.length}件`);
if (!write) {
  console.log("確認のみ。反映するには --write を付けてください。");
  process.exit(0);
}
for (const { file, source } of updated) writeFileSync(file, source);
const allowlistPath = "tests/regression/fixtures/landmark-height-unverified-allowlist.json";
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
allowlist.names = allowlist.names.filter((name) => !client.applied.includes(name));
writeFileSync(allowlistPath, `${JSON.stringify(allowlist, null, 2)}\n`);
appendFileSync("LANDMARK_HEIGHT_RESEARCH_20260929.md",
  `\n## PLATEAU＋DEM実測の反映（${audit.measuredAtIso}）\n` +
  "高さ = PLATEAU頂上の楕円体高 − 登録座標のGSI DEM地表の楕円体高（アプリと同じ地表・ジオイド）。\n\n" +
  "| 名称 | 判定 | 参考 |\n|---|---|---|\n" + lines.join("\n") + "\n");
console.log("カタログ・未確認リスト・調査記録を更新しました。npm test で確認してください。");
