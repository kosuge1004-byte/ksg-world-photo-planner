import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));

const expectedFunctions = [
  "resolve-google-maps",
  "geocode",
  "timezone",
  "gsi-elevation",
  "gsi-geoid",
  "osm-site-context",
  "spot-search-start",
  "spot-search-status",
  "spot-search-finalize",
];
for (const functionName of expectedFunctions) {
  const relativePath = `functions/api/${functionName}.ts`;
  if (!exists(relativePath)) throw new Error(`Missing Pages Function: ${relativePath}`);
}

if (exists("netlify.toml")) {
  throw new Error("Netlify configuration remains: netlify.toml");
}
if (exists("netlify")) {
  const netlifyRoot = path.join(root, "netlify");
  const filesRemain = fs.readdirSync(netlifyRoot, { recursive: true })
    .some((entry) => fs.statSync(path.join(netlifyRoot, entry)).isFile());
  if (filesRemain) throw new Error("Netlify function files remain: netlify/");
}

const packageJson = JSON.parse(read("package.json"));
const installedPackages = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
};
for (const dependency of [
  "@netlify/functions",
  "@netlify/blobs",
  "@netlify/vite-plugin",
]) {
  if (dependency in installedPackages) {
    throw new Error(`Netlify dependency remains: ${dependency}`);
  }
}

const pagesConfig = read("wrangler.jsonc");
const consumerConfig = read("wrangler.spot-search.jsonc");
if (!/SPOT_SEARCH_JOBS/.test(pagesConfig) || !/SPOT_SEARCH_QUEUE/.test(pagesConfig)) {
  throw new Error("Pages bindings are incomplete");
}
if (!/astrosight-spot-search/.test(consumerConfig) ||
    !/spot-search-consumer\.ts/.test(consumerConfig)) {
  throw new Error("Queue consumer configuration is incomplete");
}

const gitignore = read(".gitignore");
for (const pattern of ["node_modules", "dist", ".env", ".dev.vars", ".wrangler"]) {
  if (!gitignore.includes(pattern)) throw new Error(`.gitignore is missing ${pattern}`);
}

const redirects = read("public/_redirects");
const headers = read("public/_headers");
if (!/SPA/i.test(redirects) || exists("public/404.html")) {
  throw new Error("Cloudflare Pages automatic SPA fallback is disabled");
}
if (!/X-Robots-Tag:\s*noindex,\s*nofollow/i.test(headers)) {
  throw new Error("Search-engine exclusion header is missing");
}

console.log(JSON.stringify({
  pagesFunctions: expectedFunctions.length,
  kvBinding: true,
  queueConsumer: true,
  netlifyRemoved: true,
  spaRouting: true,
}));
