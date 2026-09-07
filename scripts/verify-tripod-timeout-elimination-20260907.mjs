import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const tripod = read("src/cesium/tripodCandidates.ts");
const client = read("src/search/siteContext.ts");
const server = read("server/osmSiteContext.ts");
const api = read("functions/api/osm-site-context.ts");

const checks = [
  ["water-only purpose exists client", client.includes('"water-only"')],
  ["water-only purpose exists server", server.includes('"water-only"')],
  ["water-only purpose accepted by API", api.includes('requestedPurpose === "height-only" || requestedPurpose === "water-only"')],
  ["water-only bypasses shared in-flight request", client.includes('purpose === "water-only"') && client.includes('? await request()')],
  ["water-only request propagates AbortSignal to fetch", client.includes('body: JSON.stringify(requestBody),\n      signal,')],
  ["river probes keep all 10 radii", tripod.includes('RIVER_NEAREST_LAND_RADII_METERS.flatMap')],
  ["river probes keep all 8 bearings", tripod.includes('RIVER_NEAREST_LAND_BEARINGS_DEGREES.map')],
  ["river terrain is batched", tripod.includes('probes.map((probe) => probe.cartographic)')],
  ["river water classification is one water-only call", tripod.includes('probeGroundPoints,\n      waterController.signal,\n      false,\n      "water-only"')],
  ["river water helper has finite 7s budget", tripod.includes('const WATER_ONLY_TIMEOUT_MS = 7_000')],
  ["initial water helper has finite 5s budget", tripod.includes('const WATER_SURFACE_CHECK_TIMEOUT_MS = 5_000')],
  ["initial water helper uses real abort", tripod.includes('() => waterController.abort()')],
  ["old Promise.race water timeout removed", !tripod.includes('水面判定がタイムアウトしました（${WATER_SURFACE_CHECK_TIMEOUT_MS}ms）')],
  ["server allows one 80-point water-only request", server.includes('purpose === "water-only" ? 80 : 8')],
  ["server water-only query excludes highway/access", server.includes('if (purpose === "water-only")') && server.includes('`nwr${around}["natural"="water"]`')],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (ok) console.log(`PASS: ${name}`);
  else { console.error(`FAIL: ${name}`); failed += 1; }
}
if (failed) process.exit(1);
console.log(`Tripod timeout-elimination regression: PASS (${checks.length}/${checks.length})`);
