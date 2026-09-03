import { spawnSync } from "node:child_process";

const cases = [
  {
    name: "3D map pointer overlay contract (2026-09-03)",
    arguments: ["./scripts/verify-3d-map-input-20260903.mjs"],
  },
  {
    name: "3D map Cesium render-loop contract (2026-09-03)",
    arguments: ["./scripts/verify-3d-map-render-loop-20260903.mjs"],
  },
  {
    name: "production calculation regression",
    arguments: [
      "--import",
      "./scripts/register-typescript-source-loader.mjs",
      "--test",
      "./tests/regression/core-calculations.test.mjs",
    ],
  },
  {
    name: "tripod candidate round-trip / multi-intersection / height-basis regression",
    arguments: [
      "--import",
      "./scripts/register-typescript-source-loader.mjs",
      "--test",
      "./tests/regression/tripod-candidate-round-trip.test.mjs",
    ],
  },
  {
    name: "tripod candidate and preview share the same forward terrain model",
    arguments: ["./scripts/verify-tripod-preview-forward-model-20260830.mjs"],
  },
  {
    name: "tripod candidate progressive display and finite fallback waits",
    arguments: ["./scripts/verify-tripod-candidate-performance-resilience.mjs"],
  },
  {
    name: "tripod candidate visible fallback and progressive rendering",
    arguments: ["./scripts/verify-tripod-candidate-rendering.mjs"],
  },
  {
    name: "surface obstruction (building + vegetation) line-of-sight geometry (Phase2-3)",
    arguments: [
      "--import",
      "./scripts/register-typescript-source-loader.mjs",
      "--test",
      "./tests/regression/surface-obstruction-line-of-sight.test.mjs",
    ],
  },
  {
    name: "viewCorrection integration wiring",
    arguments: ["./scripts/verify-view-correction.mjs"],
  },
  {
    name: "Karney inverse geodesic references",
    arguments: ["./scripts/verify-geodesic-comparison.mjs"],
  },
  {
    name: "Karney direct geodesic references",
    arguments: ["./scripts/verify-geodesic-direct.mjs"],
  },
  {
    name: "shared frame-boundary wiring and telephoto sampling",
    arguments: ["./scripts/verify-frame-boundaries.mjs"],
  },
  {
    name: "condition-complete cache keys and invalidation",
    arguments: ["./scripts/verify-cache-keys.mjs"],
  },
  {
    name: "stale search-generation rejection",
    arguments: ["./scripts/verify-search-generation.mjs"],
  },
  {
    name: "search progress, generation and ETA",
    arguments: ["./scripts/verify-search-progress.mjs"],
  },
  {
    name: "progressive DEM/Google 3D occlusion wiring",
    arguments: ["./scripts/verify-occlusion-state.mjs"],
  },
  {
    name: "user-visible errors and fallbacks",
    arguments: ["./scripts/verify-user-error-handling.mjs"],
  },
  {
    name: "precision descriptions and unchanged defaults",
    arguments: ["./scripts/verify-precision-descriptions.mjs"],
  },
  {
    name: "performance and lifecycle cleanup",
    arguments: ["./scripts/verify-performance-lifecycle.mjs"],
  },
  {
    name: "focal-length input contract",
    arguments: ["./scripts/verify-focal-length-input.mjs"],
  },
  {
    name: "Google Maps URL parsing",
    arguments: ["./scripts/verify-google-maps-url.mjs"],
  },
  {
    name: "static Japan landmark instant search",
    arguments: ["./scripts/verify-static-landmark-search-20260831.mjs"],
  },
  {
    name: "Android, iPhone and browser compatibility contracts",
    arguments: ["./scripts/verify-platform-compatibility.mjs"],
  },
  {
    name: "3D map pointer input is not blocked by 2D placement overlays",
    arguments: ["./scripts/verify-3d-map-input-20260903.mjs"],
  },
  {
    name: "final source cleanup and strict TypeScript contracts",
    arguments: ["./scripts/verify-final-cleanup.mjs"],
  },
  {
    name: "search engine indexing exclusion contracts",
    arguments: ["./scripts/verify-search-engine-exclusion.mjs"],
  },
  {
    name: "Chrome PWA installability contracts",
    arguments: ["./scripts/verify-pwa-installability.mjs"],
  },
  {
    name: "resilient Cloudflare DEM batching",
    arguments: [
      "--import",
      "./scripts/register-typescript-source-loader.mjs",
      "--test",
      "./tests/regression/gsi-elevation-client.test.mjs",
    ],
  },
  {
    name: "GSI elevation R2, memory, shared and bypass cache paths",
    arguments: [
      "--import",
      "./scripts/register-typescript-source-loader.mjs",
      "--test",
      "./tests/regression/gsi-elevation-cache-path.test.mjs",
    ],
  },
  {
    name: "constrained bicubic interpolation (overshoot clamping)",
    arguments: [
      "--import",
      "./scripts/register-typescript-source-loader.mjs",
      "./tests/regression/constrained-bicubic-interpolation.test.mjs",
    ],
  },
  {
    name: "DEM 4x4 neighborhood: tile boundary, NoData, sea gaps, cliffs, LOS safe-side (Phase F-1)",
    arguments: [
      "--import",
      "./scripts/register-typescript-source-loader.mjs",
      "./tests/regression/gsi-elevation-neighborhood.test.mjs",
    ],
  },
  {
    name: "celestial occlusion recalculation and boundary stability",
    arguments: ["./scripts/verify-celestial-occlusion-stability.mjs"],
  },
  {
    name: "person placement and display contracts",
    arguments: ["./scripts/verify-person-display.mjs"],
  },
  {
    name: "Cloudflare Pages Functions migration contracts",
    arguments: ["./scripts/verify-cloudflare-migration.mjs"],
  },
  {
    name: "R2 full free-tier safety on all cache paths",
    arguments: ["./scripts/verify-r2-safety-all-paths-20260824.mjs"],
  },
  {
    name: "device DEM tile cache parity with server interpolation",
    arguments: ["--experimental-strip-types", "./scripts/verify-device-dem-tile-cache-20260829.mjs"],
  },
  {
    name: "tripod candidate speed caches preserve exact-result safety (persistent per-device seed cache disabled)",
    arguments: ["--experimental-strip-types", "./scripts/verify-tripod-speed-cache-20260829.mjs"],
  },
  {
    name: "Cloudflare API and geo-tz runtime contracts",
    arguments: [
      "--import",
      "./scripts/register-typescript-source-loader.mjs",
      "--test",
      "./tests/regression/cloudflare-functions.test.mjs",
    ],
  },
];

for (const testCase of cases) {
  console.log(`\n[regression] ${testCase.name}`);
  const result = spawnSync(process.execPath, testCase.arguments, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    throw new Error(`${testCase.name}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${testCase.name} failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

console.log(`\nRegression suite: PASS (${cases.length} groups)`);
