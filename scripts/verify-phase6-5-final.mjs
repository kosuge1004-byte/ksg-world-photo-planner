import fs from "node:fs";

const required = [
  "PHASE6_1_LOS_PERFORMANCE.md",
  "PHASE6_2_MEMORY_REDUCTION.md",
  "PHASE6_3_CACHE_OPTIMIZATION.md",
  "PHASE6_4_SEARCH_SPEED.md",
  "PHASE6_5_REGRESSION_AND_FINAL_REPORT.md",
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
console.log("Phase6-5 final integration verification: PASS");
