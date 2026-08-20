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
// JSONC（行コメント付き）のため、素のJSON.parse前にコメントを取り除く。
const stripJsonComments = (text) =>
  text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"])\/\/.*$/, (match, prefix) => prefix))
    .join("\n");
const pagesConfigJson = JSON.parse(stripJsonComments(pagesConfig));
const consumerConfigJson = JSON.parse(stripJsonComments(consumerConfig));
const expectedKvNamespaceId = "92197c38d81d48489ef4fdd25b1b9a58";
const expectedKvBinding = "SPOT_SEARCH_JOBS";
const expectedQueue = "astrosight-spot-search";

if (pagesConfigJson.name !== "astrosight") {
  throw new Error("Pages project name must be astrosight");
}
for (const [configName, config] of [
  ["Pages", pagesConfigJson],
  ["Consumer", consumerConfigJson],
]) {
  const kvBindings = config.kv_namespaces ?? [];
  const kvBinding = kvBindings.find((entry) => entry.binding === expectedKvBinding);
  if (kvBindings.length !== 1 || kvBinding?.id !== expectedKvNamespaceId) {
    throw new Error(`${configName} KV binding must map ${expectedKvBinding} to ${expectedKvNamespaceId}`);
  }
  if ("preview_id" in kvBinding || /REPLACE_WITH_/.test(JSON.stringify(config))) {
    throw new Error(`${configName} KV binding contains a preview ID or placeholder`);
  }
}

const queueProducer = pagesConfigJson.queues?.producers?.find(
  (entry) => entry.binding === "SPOT_SEARCH_QUEUE",
);
if (queueProducer?.queue !== expectedQueue) {
  throw new Error("Pages queue producer binding is incomplete");
}
if (consumerConfigJson.main !== "./workers/spot-search-consumer.ts" ||
    consumerConfigJson.queues?.consumers?.[0]?.queue !== expectedQueue) {
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
  pagesProject: pagesConfigJson.name,
  kvNamespaceId: expectedKvNamespaceId,
  kvBinding: true,
  queueConsumer: true,
  netlifyRemoved: true,
  spaRouting: true,
}));
