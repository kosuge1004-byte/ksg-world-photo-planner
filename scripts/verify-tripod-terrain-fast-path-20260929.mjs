import fs from "node:fs";

const client = fs.readFileSync("src/cesium/gsiElevationClient.ts", "utf8");
const world = fs.readFileSync("src/cesium/worldTerrain.ts", "utf8");
const server = fs.readFileSync("server/gsiElevation.ts", "utf8");
const api = fs.readFileSync("functions/api/gsi-elevation.ts", "utf8");

const checks = [
  [
    "10m rough scans keep a single <=1024-point HTTP batch",
    client.includes('if (points.every((point) => point.maximumDetail === "10m"))') &&
      client.includes("return REQUEST_BATCH_SIZE;") &&
      client.includes("const REQUEST_BATCH_SIZE = 1024")
  ],
  [
    "client tags live terrain traffic as interactive",
    world.includes('? "bulk-download"') &&
      world.includes(': "interactive"') &&
      client.includes("JSON.stringify({ points, purpose })")
  ],
  [
    "interactive and bulk requests cannot merge in one microtask batch",
    world.includes("pendingGsiRequestKey(interpolationMode, purpose)") &&
      world.includes("flushGsiRequests(signal, interpolationMode, purpose)")
  ],
  // 2026-09-30: 方針変更。ライブ操作もEドライブを使い、全経路で
  // 端末内 → R2 → Eドライブ → 国土地理院 の順にする。
  [
    "every API request uses R2 before the E-drive gateway",
    api.includes("{ useLocalGateway: true }") &&
      server.includes("const useLocalGateway = options.useLocalGateway !== false") &&
      server.includes("if (useLocalGateway && unresolved.size > 0 && !(await localDemManifestAvailable()))")
  ],
  [
    "bulk download keeps the private gateway path",
    world.includes('options.allowWorldTerrainFallback === false') &&
      world.includes('"bulk-download"') &&
      server.includes("lookupLocalDemGatewayAuto") &&
      server.includes("lookupLocalDemGatewayForSource")
  ],
  [
    "precision source order remains unchanged",
    server.includes('{ id: "dem1a_png", label: "DEM1A", zoom: 17 }') &&
      server.includes('{ id: "dem5a_png", label: "DEM5A", zoom: 15 }') &&
      server.includes('{ id: "dem5b_png", label: "DEM5B", zoom: 15 }') &&
      server.includes('{ id: "dem5c_png", label: "DEM5C", zoom: 15 }') &&
      server.includes('{ id: "dem_png", label: "DEM10B", zoom: 14 }')
  ],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
