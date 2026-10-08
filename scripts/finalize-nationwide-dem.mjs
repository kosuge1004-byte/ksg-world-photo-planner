import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const READY_FORMAT = "astrosight-nationwide-dem-ready-v1";

function option(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

async function walkZipNames(root) {
  const names = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        names.set(entry.name.toLowerCase(), target);
      }
    }
  }
  return names;
}

async function directoryHasZip(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"));
  } catch {
    return false;
  }
}

async function acceptedReplacementArchives(archiveRoot, missing) {
  const accepted = [];
  const rejected = [];
  const dem1Available = await directoryHasZip(path.join(
    archiveRoot, "mesh-highres-kyushu-okinawa", "DEM1A"
  ));
  const dem5Available = await Promise.all(["DEM5A", "DEM5B", "DEM5C"].map((source) =>
    directoryHasZip(path.join(archiveRoot, "mesh-highres-kyushu-okinawa", source))
  )).then((values) => values.every(Boolean));
  for (const name of missing) {
    const match = /^FG-GML-kyushu_okinawa-(DEM1|DEM5)-.+\.zip$/iu.exec(name);
    if (match?.[1] === "DEM1" && dem1Available) accepted.push(name);
    else if (match?.[1] === "DEM5" && dem5Available) accepted.push(name);
    else rejected.push(name);
  }
  return { accepted, rejected };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function emptyTotals() {
  return { assetCount: 0, gzipBytes: 0, rawBytes: 0 };
}

async function auditInventory(inventoryPath) {
  const totals = emptyTotals();
  const sources = new Map();
  const reader = readline.createInterface({
    input: createReadStream(inventoryPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (typeof entry.objectKey !== "string" || typeof entry.source !== "string" ||
      !Number.isSafeInteger(entry.gzipBytes) || entry.gzipBytes < 1 ||
      !Number.isSafeInteger(entry.rawBytes) || entry.rawBytes < 1 ||
      typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error("全国DEM inventoryに不正な行があります");
    }
    const source = sources.get(entry.source) ?? emptyTotals();
    source.assetCount += 1;
    source.gzipBytes += entry.gzipBytes;
    source.rawBytes += entry.rawBytes;
    sources.set(entry.source, source);
    totals.assetCount += 1;
    totals.gzipBytes += entry.gzipBytes;
    totals.rawBytes += entry.rawBytes;
  }
  return { totals, sources: Object.fromEntries(sources) };
}

function assertTotals(label, actual, expected) {
  for (const key of ["assetCount", "gzipBytes", "rawBytes"]) {
    if (actual[key] !== expected[key]) {
      throw new Error(`${label}の${key}がmanifestと一致しません`);
    }
  }
}

const archiveRoot = path.resolve(option(
  "archive-root",
  "E:/AstroSight-GSI-data-20260926/dem/official-archive"
));
const outputRoot = path.resolve(option(
  "output-root",
  "E:/AstroSight-GSI-data-20260926/dem/r2-ready"
));
const downloadManifestPath = path.resolve(option(
  "download-manifest",
  "dem/gsi-dem-download-manifest.json"
));
const assetRoot = path.join(outputRoot, "gsi-local-dem-v1");
const manifestPath = path.join(assetRoot, "manifest.json");
const inventoryPath = path.join(assetRoot, "asset-inventory.jsonl");
const readyPath = path.join(assetRoot, "nationwide-ready-v1.json");
const temporaryReadyPath = `${readyPath}.${process.pid}.${randomUUID()}.tmp`;

await rm(temporaryReadyPath, { force: true });
const [downloadManifest, localManifest, archiveNames] = await Promise.all([
  readFile(downloadManifestPath, "utf8").then(JSON.parse),
  readFile(manifestPath, "utf8").then(JSON.parse),
  walkZipNames(archiveRoot),
]);

if (!Array.isArray(downloadManifest.files) || downloadManifest.files.length === 0) {
  throw new Error("全国DEMダウンロード一覧が不正です");
}
if (localManifest.schemaVersion !== 1 ||
  localManifest.format !== "astrosight-gsi-local-dem-v1" ||
  !Number.isSafeInteger(localManifest.assetCount) || localManifest.assetCount < 1) {
  throw new Error("全国DEM変換manifestが不正です");
}

const expectedNames = downloadManifest.files.map((entry) => String(entry.filename));
const missing = expectedNames.filter((name) => !archiveNames.has(name.toLowerCase()));
const replacements = await acceptedReplacementArchives(archiveRoot, missing);
if (replacements.rejected.length > 0) {
  throw new Error(`全国DEMの未取得ファイルが${replacements.rejected.length}件あります`);
}

const inventory = await auditInventory(inventoryPath);
assertTotals("全国DEM全体", inventory.totals, localManifest);
for (const [source, expected] of Object.entries(localManifest.sources ?? {})) {
  const actual = inventory.sources[source];
  if (!actual) throw new Error(`${source}のinventoryがありません`);
  assertTotals(source, actual, expected);
}
if (!inventory.sources.DEM10B?.assetCount ||
  !inventory.sources.DEM1A?.assetCount ||
  !(inventory.sources.DEM5A?.assetCount || inventory.sources.DEM5B?.assetCount ||
    inventory.sources.DEM5C?.assetCount)) {
  throw new Error("全国DEMの必須解像度が揃っていません");
}

const [manifestSha256, inventorySha256, manifestStat, inventoryStat] = await Promise.all([
  sha256File(manifestPath),
  sha256File(inventoryPath),
  stat(manifestPath),
  stat(inventoryPath),
]);
const ready = {
  schemaVersion: 1,
  format: READY_FORMAT,
  status: "complete",
  completedAt: new Date().toISOString(),
  manifestSha256,
  inventorySha256,
  manifestBytes: manifestStat.size,
  inventoryBytes: inventoryStat.size,
  expectedArchiveCount: expectedNames.length,
  matchedArchiveCount: expectedNames.length - missing.length,
  replacementArchiveCount: replacements.accepted.length,
  replacementPolicy: replacements.accepted.length > 0
    ? "newer per-mesh Kyushu/Okinawa DEM1/5 archives"
    : null,
  assetCount: localManifest.assetCount,
  gzipBytes: localManifest.gzipBytes,
  rawBytes: localManifest.rawBytes,
  sources: localManifest.sources,
};

await mkdir(assetRoot, { recursive: true });
await writeFile(temporaryReadyPath, `${JSON.stringify(ready, null, 2)}\n`, { flag: "wx" });
await rename(temporaryReadyPath, readyPath);
console.log(JSON.stringify({
  ready: true,
  readyPath,
  expectedArchiveCount: ready.expectedArchiveCount,
  matchedArchiveCount: ready.matchedArchiveCount,
  replacementArchiveCount: ready.replacementArchiveCount,
  assetCount: ready.assetCount,
  gzipBytes: ready.gzipBytes,
}, null, 2));

