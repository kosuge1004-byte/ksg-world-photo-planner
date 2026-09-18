import fs from "node:fs";
import { spawnSync } from "node:child_process";

const required = [
  "src/cache/cachePolicies.ts",
  "src/cache/deviceCache.ts",
  "src/cesium/tripodCandidates.ts",
  "scripts/verify-phase6-1-los-performance.mjs",
  "scripts/verify-phase6-2-memory.mjs",
  "scripts/verify-phase6-3-cache-optimization.mjs",
  "scripts/verify-phase6-4-search-speed.mjs",
];
for (const path of required) {
  if (!fs.existsSync(path)) throw new Error(`Missing final artifact: ${path}`);
}
const lifecycle = fs.readFileSync("scripts/verify-performance-lifecycle.mjs", "utf8");
for (const expected of [
  "DEVICE_CACHE_POLICIES.weatherForecast",
  "DEVICE_CACHE_POLICIES.weatherClimatology",
  'const cachePolicies = read("src/cache/cachePolicies.ts")',
]) {
  if (!lifecycle.includes(expected)) throw new Error(`Missing lifecycle check: ${expected}`);
}
// Historical report Markdown files are not included in source releases. Verify
// the production contracts directly instead of treating those documents as code.
for (const script of required.filter((path) => path.startsWith("scripts/"))) {
  const result = spawnSync(process.execPath, [script], { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error(`Performance integration check failed: ${script}`);
}
console.log("Phase6-5 final integration verification: PASS");
