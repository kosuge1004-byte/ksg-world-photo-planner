import fs from "node:fs";

const terrain = fs.readFileSync("src/cesium/worldTerrain.ts", "utf8");
const geoid = fs.readFileSync("functions/api/gsi-geoid.ts", "utf8");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

const checks = [
  [terrain.includes('diagnosticFetch("gsi-geoid", "/api/gsi-geoid"'), "最高精度ジオイドが診断付きPOSTへ統合されている"],
  [terrain.includes('body: JSON.stringify({ points: geoidPoints, precision: "point" })'), "複数地点を1回のAPI呼び出しへバッチ化している"],
  [terrain.includes('shareInFlightRequest({') && terrain.includes('category: "gsi-geoid"'), "同一ジオイドバッチ要求を共有している"],
  [!terrain.includes('requested.map(async (point, index) =>') || !terrain.includes('precision=point`'), "地点ごとの個別ジオイドGETを廃止している"],
  [geoid.includes('request.method === "POST"'), "CloudflareジオイドAPIがPOSTバッチを受け付ける"],
  [geoid.includes('body.points.length > 512'), "バッチ件数に上限がある"],
  [geoid.includes('namespace: "gsi-geoid-batch"'), "バッチ結果をR2へ保存する"],
  [geoid.includes('Promise.all(parsed.points.map'), "サーバー側で複数地点をまとめて処理する"],
  [pkg.scripts?.["verify:phase5-5"]?.includes("verify-phase5-5-api-reduction.mjs"), "検証コマンドが登録されている"],
];

let failed = 0;
for (const [ok, message] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${message}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log("Phase5-5 API reduction verification passed.");
