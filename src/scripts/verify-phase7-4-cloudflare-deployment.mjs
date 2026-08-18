import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));
const fail = (message) => { throw new Error(message); };

const packageJson = JSON.parse(read("package.json"));
const pages = JSON.parse(read("wrangler.jsonc"));
const consumer = JSON.parse(read("wrangler.spot-search.jsonc"));
const envSource = read("functions/_shared/env.ts");
const headers = read("public/_headers");
const redirects = read("public/_redirects");
const manifest = JSON.parse(read("public/manifest.webmanifest"));
const serviceWorker = read("public/sw.js");
const indexHtml = read("index.html");
const pwaInstallSource = read("src/pwa/install.ts");
const gitignore = read(".gitignore");

const expectedFunctions = [
  "resolve-google-maps", "geocode", "timezone", "gsi-elevation", "gsi-geoid",
  "osm-site-context", "spot-search-start", "spot-search-status", "spot-search-finalize",
];
for (const name of expectedFunctions) {
  if (!exists(`functions/api/${name}.ts`)) fail(`Pages Function missing: ${name}`);
}
if (!exists("workers/spot-search-consumer.ts")) fail("Queue consumer source missing");

if (pages.name !== "astrosight" || pages.pages_build_output_dir !== "./dist") {
  fail("Pages project/output configuration is invalid");
}
if (!/^2026-\d{2}-\d{2}$/.test(pages.compatibility_date ?? "")) {
  fail("Pages compatibility_date is missing or malformed");
}
if (!Array.isArray(pages.compatibility_flags) || !pages.compatibility_flags.includes("nodejs_compat")) {
  fail("Pages nodejs_compat flag is missing");
}

const kvBinding = pages.kv_namespaces?.find((v) => v.binding === "SPOT_SEARCH_JOBS");
const consumerKv = consumer.kv_namespaces?.find((v) => v.binding === "SPOT_SEARCH_JOBS");
if (!kvBinding?.id || kvBinding.id !== consumerKv?.id) fail("Pages/consumer KV binding mismatch");
const producer = pages.queues?.producers?.find((v) => v.binding === "SPOT_SEARCH_QUEUE");
const queueName = producer?.queue;
if (!queueName || consumer.queues?.consumers?.[0]?.queue !== queueName) fail("Queue producer/consumer mismatch");
if (consumer.main !== "./workers/spot-search-consumer.ts") fail("Consumer entry point mismatch");
if (consumer.queues?.consumers?.[0]?.max_batch_size !== 1) fail("Consumer must process one search job per batch");

for (const binding of ["ASSETS", "SPOT_SEARCH_JOBS", "SPOT_SEARCH_QUEUE"]) {
  if (!new RegExp(`\\b${binding}\\b`).test(envSource)) fail(`CloudflareEnv missing ${binding}`);
}
for (const optional of ["CESIUM_ION_TOKEN", "VITE_CESIUM_ION_TOKEN", "GOOGLE_MAPS_API_KEY", "NETWORK_CACHE"]) {
  if (!new RegExp(`\\b${optional}\\??:`).test(envSource)) fail(`CloudflareEnv missing optional binding ${optional}`);
}

if (!/X-Robots-Tag:\s*noindex,\s*nofollow/i.test(headers)) fail("X-Robots-Tag exclusion missing");
if (!/Permissions-Policy:/i.test(headers)) fail("Permissions-Policy missing");
if (!/\/sw\.js[\s\S]*Cache-Control:\s*no-cache/i.test(headers)) fail("Service worker no-cache header missing");
if (!/\/manifest\.webmanifest[\s\S]*Cache-Control:\s*no-cache/i.test(headers)) fail("Manifest no-cache header missing");
if (/^\s*\/\*\s+\/index\.html\s+200/m.test(redirects)) fail("Cyclic SPA redirect rule is present");
if (exists("public/404.html")) fail("404.html disables Pages automatic SPA fallback");

if (manifest.name !== "AstroSight" || manifest.display !== "standalone" || manifest.scope !== "/") {
  fail("PWA manifest core fields are invalid");
}
if (!Array.isArray(manifest.icons) || !manifest.icons.some((v) => v.sizes === "192x192") || !manifest.icons.some((v) => v.sizes === "512x512")) {
  fail("Required PWA icons are missing");
}
if (!/navigator\.serviceWorker|serviceWorker\.register/.test(indexHtml + read("src/main.tsx") + pwaInstallSource)) {
  fail("Service worker registration is missing");
}
for (const eventName of ["install", "activate", "fetch"]) {
  if (!new RegExp(`addEventListener\\(\\s*['"]${eventName}['"]`).test(serviceWorker)) fail(`Service worker ${eventName} handler missing`);
}
if (!/url\.pathname\.startsWith\(\s*["']\/api\/["']\s*\)/.test(serviceWorker)) fail("Service worker must bypass API requests");

for (const pattern of ["node_modules", "dist", ".env", ".dev.vars", ".wrangler"]) {
  if (!gitignore.includes(pattern)) fail(`.gitignore missing ${pattern}`);
}
for (const scriptName of ["build", "cf:pages:deploy", "cf:consumer:deploy", "verify:cloudflare"]) {
  if (!packageJson.scripts?.[scriptName]) fail(`package script missing: ${scriptName}`);
}

const result = {
  pagesFunctions: expectedFunctions.length,
  pagesProject: pages.name,
  outputDirectory: pages.pages_build_output_dir,
  kvBinding: kvBinding.binding,
  queue: queueName,
  queueConsumer: true,
  r2CacheBinding: "optional (NETWORK_CACHE)",
  pwa: true,
  serviceWorkerApiBypass: true,
  spaFallback: "Cloudflare Pages automatic",
  securityHeaders: true,
  deploymentScripts: true,
};
console.log(JSON.stringify(result, null, 2));
