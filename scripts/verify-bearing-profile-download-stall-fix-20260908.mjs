import fs from "node:fs";
const manager = fs.readFileSync("src/cache/tripodBearingProfileManager.ts", "utf8");
const terrain = fs.readFileSync("src/cesium/worldTerrain.ts", "utf8");
const tiles = fs.readFileSync("src/cesium/gsiDemTileCache.ts", "utf8");
const dialog = fs.readFileSync("src/components/BearingProfileDownloadDialog.tsx", "utf8");
const runner = fs.readFileSync("scripts/run-regression-tests.mjs", "utf8");
// An entire-bearing deadline rejected healthy, rate-limited geoid queues.
// Production runtime tests verify cancellation and source-preserving cache reuse.
const checks = [
 ["healthy bearing queue waits are not timed out", !manager.includes("PER_ATTEMPT_TIMEOUT_MS")],
 ["geoid HTTP has a cancellable deadline after acquiring a slot", /const release = await \(pointSpecific \? pointGeoidRequestSlots : geoidRequestSlots\)\.acquire\(signal\);\s*try \{\s*return await withAbortableTimeout/.test(terrain)],
 ["parent abort propagates into authoritative sampling", manager.includes('sampleWorldTerrainNeutral(terrainPoints, signal, "1m",')],
 ["discarded 10m and World Terrain download requests removed", !manager.includes('sampleWorldTerrain(terrainPoints') && manager.includes("allowWorldTerrainFallback: false")],
 ["tile drain and fetch are cancellable/bounded", manager.includes("flushGsiDeviceTilePrefetchQueue(signal)") && tiles.includes("20_000") && tiles.includes("withAbortableTimeout")],
 ["dialog exposes terrain and geoid progress", dialog.includes('terrainStage === "high-precision"') && dialog.includes("progress.geoidCompleted")],
 ["production runtime test registered", runner.includes("download-runtime.test.mjs")],
];
let failures = 0;
for (const [name, ok] of checks) { console.log((ok ? "PASS " : "FAIL ") + name); if (!ok) failures += 1; }
if (failures) process.exit(1);
