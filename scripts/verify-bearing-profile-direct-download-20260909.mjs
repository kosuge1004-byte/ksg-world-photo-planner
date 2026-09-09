import fs from "node:fs";

const manager = fs.readFileSync("src/cache/tripodBearingProfileManager.ts", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const client = fs.readFileSync("src/cesium/gsiElevationClient.ts", "utf8");
const server = fs.readFileSync("server/gsiElevation.ts", "utf8");

const numberFrom = (text, pattern) => {
  const match = text.match(pattern);
  return match ? Number(match[1].replaceAll("_", "")) : Number.NaN;
};

const bearingConcurrency = numberFrom(manager, /BEARING_CONCURRENCY\s*=\s*([\d_]+)/);
const stageTimeout = numberFrom(manager, /BEARING_TERRAIN_STAGE_TIMEOUT_MS\s*=\s*([\d_]+)/);
const clientConcurrency = numberFrom(client, /MAX_CONCURRENT_REQUESTS\s*=\s*([\d_]+)/);
const requestTimeout = numberFrom(client, /REQUEST_TIMEOUT_MS\s*=\s*([\d_]+)/);
const serverTileConcurrency = numberFrom(server, /MAX_CONCURRENT_GSI_TILE_REQUESTS\s*=\s*([\d_]+)/);

const checks = [
  ["real client path processes more than one bearing concurrently", bearingConcurrency >= 2 && manager.includes("await Promise.all(Array.from({ length: workerCount }, () => worker()))")],
  ["bearing concurrency remains conservative", bearingConcurrency <= 3],
  ["45-second per-stage stall window removed", stageTimeout > 0 && stageTimeout <= 20_000],
  ["30-second client request stall window removed", requestTimeout > 0 && requestTimeout <= 12_000],
  ["client request fan-out is capped to six", clientConcurrency > 0 && clientConcurrency <= 6],
  ["Worker tile fan-out does not exceed six waiting outgoing connections", serverTileConcurrency > 0 && serverTileConcurrency <= 6],
  ["direct path has systemic-failure early abort", /FAILURE_ABORT_THRESHOLD\s*=\s*6/.test(manager) && manager.includes("successfulBearings === 0 && failedBearings >= FAILURE_ABORT_THRESHOLD")],
  ["direct path reports requested/successful/failed bearing counts", manager.includes("requestedBearings") && manager.includes("successfulBearings") && manager.includes("failedBearings")],
  ["World Terrain fallback is not mislabeled as downloaded high precision", manager.includes('terrainDataSource(sample) === "CESIUM_WORLD_TERRAIN"')],
  ["app rejects partial bearing download instead of marking complete", app.includes("backfillResult.successfulBearings !== backfillResult.requestedBearings") && app.includes("保存完了にはしていません")],
  ["opt-in is enabled only after completion checks", app.indexOf("enableBearingProfile(record.id") > app.indexOf("backfillResult.successfulBearings !== backfillResult.requestedBearings")],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
