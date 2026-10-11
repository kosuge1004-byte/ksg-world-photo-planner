import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";

import { listEntries } from "./remoteZip.mjs";
import {
  buildingEntryHasDuplicateBasename,
  duplicateBuildingBasenames,
  storedBuildingRelativePath,
} from "./storedBuildingPath.mjs";

const SHARD_DIRECTORY = "manifest-fragments-v1";
const MANIFEST_NAME = "manifest.ndjson";
const RECOVERY_REPORT_NAME = "manifest-recovery.json";
const LIST_CONCURRENCY = 4;

function isBuildingGml(name) {
  return /(?:^|\/)udx\/bldg\/[^/]+\.gml$/iu.test(String(name).replaceAll("\\", "/"));
}

function meshCodeFromEntry(name) {
  const match = /^(\d{6,10})_/u.exec(path.posix.basename(String(name).replaceAll("\\", "/")));
  return match ? match[1] : null;
}

const recordKey = (record) => `${record.dataset}\n${record.entry}`;
const expectedKey = (dataset, entry) => `${dataset}\n${entry.name}`;

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readNdjson(file, records) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return 0;
  }
  let loaded = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record?.dataset !== "string" || typeof record?.entry !== "string") continue;
      records.set(recordKey(record), record);
      loaded += 1;
    } catch {
      // An interrupted final append is ignored. Its stored file can be rebuilt below.
    }
  }
  return loaded;
}

export async function loadManifestRecords(outputDirectory, additionalManifestPaths = []) {
  const records = new Map();
  const sources = [];
  const root = path.join(outputDirectory, MANIFEST_NAME);
  // Imported legacy fragments are read first. Current shards and the current
  // root manifest then win if the same record also exists there.
  for (const supplied of additionalManifestPaths) {
    const file = path.resolve(supplied);
    if (file === path.resolve(root)) continue;
    const rows = await readNdjson(file, records);
    if (rows > 0) sources.push({ file, rows });
  }
  const shardRoot = path.join(outputDirectory, SHARD_DIRECTORY);
  try {
    for (const name of await readdir(shardRoot)) {
      if (!name.endsWith(".ndjson")) continue;
      const file = path.join(shardRoot, name);
      const rows = await readNdjson(file, records);
      if (rows > 0) sources.push({ file, rows });
    }
  } catch {
    // Shards are added by the repaired tool; older runs do not have them.
  }
  const rootCount = await readNdjson(root, records);
  if (rootCount > 0) sources.push({ file: root, rows: rootCount });
  return { records, sources };
}

async function replaceFileAtomic(file, contents, keepBackup = false) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.new-${process.pid}`;
  const backup = `${file}.backup`;
  await writeFile(temporary, contents, "utf8");
  const hadOriginal = await fileExists(file);
  if (hadOriginal) {
    await rm(backup, { force: true });
    await rename(file, backup);
  }
  try {
    await rename(temporary, file);
    if (!keepBackup) await rm(backup, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (hadOriginal && await fileExists(backup) && !(await fileExists(file))) {
      await rename(backup, file).catch(() => {});
    }
    throw error;
  }
}

function sortedRecords(records) {
  return [...records].sort((left, right) =>
    String(left.dataset).localeCompare(String(right.dataset), "en") ||
    String(left.entry).localeCompare(String(right.entry), "en"));
}

export async function writeCanonicalManifests(outputDirectory, records, { keepRootBackup = true } = {}) {
  const ordered = sortedRecords(records);
  const text = ordered.map((record) => JSON.stringify(record)).join("\n") + (ordered.length ? "\n" : "");
  await replaceFileAtomic(path.join(outputDirectory, MANIFEST_NAME), text, keepRootBackup);

  const byDataset = new Map();
  for (const record of ordered) {
    const list = byDataset.get(record.dataset) ?? [];
    list.push(record);
    byDataset.set(record.dataset, list);
  }
  const shardRoot = path.join(outputDirectory, SHARD_DIRECTORY);
  await mkdir(shardRoot, { recursive: true });
  const expectedShardNames = new Set();
  for (const [dataset, list] of byDataset) {
    if (!/^[a-z0-9._-]+$/iu.test(dataset)) throw new Error("manifest dataset name is unsafe");
    const name = `${dataset}.ndjson`;
    expectedShardNames.add(name);
    const shardText = list.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await replaceFileAtomic(path.join(shardRoot, name), shardText, false);
  }
  for (const name of await readdir(shardRoot)) {
    if (name.endsWith(".ndjson") && !expectedShardNames.has(name)) {
      await rm(path.join(shardRoot, name), { force: true });
    }
  }
  return ordered;
}

export async function appendManifestRecord(outputDirectory, record) {
  const line = `${JSON.stringify(record)}\n`;
  const root = path.join(outputDirectory, MANIFEST_NAME);
  const shardRoot = path.join(outputDirectory, SHARD_DIRECTORY);
  if (!/^[a-z0-9._-]+$/iu.test(record.dataset)) throw new Error("manifest dataset name is unsafe");
  await mkdir(shardRoot, { recursive: true });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(root, line, "utf8");
  await appendFile(path.join(shardRoot, `${record.dataset}.ndjson`), line, "utf8");
}

function highestLod(building) {
  const levels = Object.keys(building?.l ?? {})
    .map(Number)
    .filter((level) => Number.isInteger(level) && level >= 0 && level <= 4);
  if (levels.length > 0) return Math.max(...levels);
  return building?.l0 ? 0 : null;
}

export async function inspectStoredBuildingFile(file, expected) {
  const input = createReadStream(file);
  const gunzip = zlib.createGunzip();
  const lines = readline.createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });
  let header = null;
  let written = 0;
  let badCoordinatePolygons = 0;
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  const maxLod = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      if (!header) {
        if (value?.type !== "header") throw new Error("stored building file has no header");
        header = value;
        continue;
      }
      if (value?.type === "footer") continue;
      if (!Array.isArray(value?.b) || value.b.length !== 4 || value.b.some((number) => !Number.isFinite(number))) {
        throw new Error("stored building bbox is invalid");
      }
      south = Math.min(south, value.b[0]);
      west = Math.min(west, value.b[1]);
      north = Math.max(north, value.b[2]);
      east = Math.max(east, value.b[3]);
      badCoordinatePolygons += Number.isSafeInteger(value.bad) && value.bad >= 0 ? value.bad : 0;
      const level = highestLod(value);
      if (level === null) throw new Error("stored building has no supported geometry");
      maxLod[level] += 1;
      written += 1;
    }
  } finally {
    lines.close();
    input.destroy();
    gunzip.destroy();
  }
  if (!header || header.dataset !== expected.target.dataset || header.entry !== expected.entry.name) {
    throw new Error("stored building header does not match expected entry");
  }
  if (written < 1) throw new Error("stored building file contains no building records");
  return {
    written,
    badCoordinatePolygons,
    bbox: [south, west, north, east],
    maxLod,
  };
}

function buildRecord(expected, inspected, storedBytes) {
  const { target, entry } = expected;
  const relative = storedBuildingRelativePath(target.dataset, entry.name, expected.disambiguate);
  return {
    dataset: target.dataset,
    year: target.year,
    cityCode: target.cityCode,
    special: target.special,
    entry: entry.name,
    mesh: meshCodeFromEntry(entry.name),
    file: inspected ? relative : null,
    bbox: inspected?.bbox ?? null,
    buildings: inspected?.written ?? 0,
    written: inspected?.written ?? 0,
    withoutGeometry: 0,
    badCoordinatePolygons: inspected?.badCoordinatePolygons ?? 0,
    maxLod: inspected?.maxLod ?? { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 },
    sourceBytes: entry.uncompressedSize,
    downloadedBytes: entry.compressedSize,
    crc: entry.crc >>> 0,
    storedBytes,
  };
}

function aggregate(records) {
  const sum = (field) => records.reduce((total, record) => total + (record[field] ?? 0), 0);
  const maxLod = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const record of records) {
    for (const [level, count] of Object.entries(record.maxLod ?? {})) {
      maxLod[level] = (maxLod[level] ?? 0) + count;
    }
  }
  return {
    files: records.length,
    buildings: sum("buildings"),
    written: sum("written"),
    withoutGeometry: sum("withoutGeometry"),
    badCoordinatePolygons: sum("badCoordinatePolygons"),
    buildingsByHighestLod: maxLod,
    downloadedBytes: sum("downloadedBytes"),
    sourceBytes: sum("sourceBytes"),
    storedBytes: sum("storedBytes"),
  };
}

function assertSummaryMatches(actual, summary) {
  const scalar = [
    "files", "buildings", "written", "withoutGeometry", "badCoordinatePolygons",
    "downloadedBytes", "sourceBytes", "storedBytes",
  ];
  for (const field of scalar) {
    if (actual[field] !== summary[field]) {
      throw new Error(`manifest recovery aggregate mismatch: ${field}`);
    }
  }
  for (const level of ["0", "1", "2", "3", "4"]) {
    if ((actual.buildingsByHighestLod[level] ?? 0) !== (summary.buildingsByHighestLod?.[level] ?? 0)) {
      throw new Error(`manifest recovery aggregate mismatch: LOD${level}`);
    }
  }
}

async function listExpected(targets, listArchive, log) {
  const all = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const index = next;
      next += 1;
      const target = targets[index];
      const archive = await listArchive(target.url);
      const entries = archive.entries.filter((entry) => isBuildingGml(entry.name));
      const duplicateBasenames = duplicateBuildingBasenames(entries);
      if (target.expectedFiles !== undefined && entries.length !== target.expectedFiles) {
        throw new Error(`remote directory count changed for ${target.dataset}`);
      }
      for (const entry of entries) all.push({
        target,
        entry,
        disambiguate: buildingEntryHasDuplicateBasename(entry, duplicateBasenames),
      });
      if ((index + 1) % 25 === 0) log?.(`記録復旧: 配布元一覧 ${index + 1}/${targets.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, targets.length) }, worker));
  return all;
}

/**
 * Recover a completed run whose root manifest was moved or truncated.
 * Remote ZIP bodies are never downloaded. Only central directories are read;
 * missing metadata is rebuilt from the already stored gzip files.
 */
export async function recoverCompletedManifest({
  targets,
  outputDirectory,
  additionalManifestPaths = [],
  listArchive = listEntries,
  log = console.log,
  force = false,
}) {
  const summaryPath = path.join(outputDirectory, "summary.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  if (!summary.complete || summary.files !== summary.expectedFiles || summary.withoutGeometry !== 0) {
    throw new Error("only a complete zero-geometry-loss run can be rebuilt without source bodies");
  }
  const loaded = await loadManifestRecords(outputDirectory, additionalManifestPaths);
  if (!force && loaded.records.size === summary.expectedFiles) {
    const ordered = await writeCanonicalManifests(outputDirectory, loaded.records.values());
    return { repaired: 0, records: ordered, sources: loaded.sources };
  }

  const expected = await listExpected(targets, listArchive, log);
  if (expected.length !== summary.expectedFiles) throw new Error("expected entry count does not match completed summary");
  const expectedMap = new Map(expected.map((item) => [expectedKey(item.target.dataset, item.entry), item]));
  const records = new Map();
  for (const [key, record] of loaded.records) {
    if (!expectedMap.has(key)) continue;
    if (record.file && !(await fileExists(path.join(outputDirectory, record.file)))) continue;
    records.set(key, record);
  }

  const missing = expected.filter((item) => !records.has(expectedKey(item.target.dataset, item.entry)));
  log?.(`記録復旧: ${missing.length}件を保存済みデータから確認します`);
  let next = 0;
  let repaired = 0;
  const workers = Array.from({ length: Math.min(4, Math.max(1, missing.length)) }, async () => {
    while (next < missing.length) {
      const index = next;
      next += 1;
      const item = missing[index];
      const relative = storedBuildingRelativePath(item.target.dataset, item.entry.name, item.disambiguate);
      const file = path.join(outputDirectory, relative);
      let record;
      try {
        const fileStat = await stat(file);
        const inspected = await inspectStoredBuildingFile(file, item);
        record = buildRecord(item, inspected, fileStat.size);
      } catch (error) {
        if (await fileExists(file)) throw error;
        record = buildRecord(item, null, 0);
      }
      records.set(expectedKey(item.target.dataset, item.entry), record);
      repaired += 1;
      if (repaired % 100 === 0 || repaired === missing.length) {
        log?.(`記録復旧: ${repaired}/${missing.length}`);
      }
    }
  });
  await Promise.all(workers);
  const ordered = sortedRecords(records.values());
  if (ordered.length !== summary.expectedFiles) throw new Error("recovered manifest is incomplete");
  const actual = aggregate(ordered);
  assertSummaryMatches(actual, summary);
  await writeCanonicalManifests(outputDirectory, ordered, { keepRootBackup: true });
  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    complete: true,
    expectedFiles: summary.expectedFiles,
    loadedUniqueRecords: loaded.records.size,
    repairedRecords: repaired,
    manifestRows: ordered.length,
    sourceFragments: loaded.sources.map((source) => ({ rows: source.rows })),
    aggregatesVerified: true,
  };
  await replaceFileAtomic(
    path.join(outputDirectory, RECOVERY_REPORT_NAME),
    `${JSON.stringify(report, null, 1)}\n`,
    false
  );
  return { repaired, records: ordered, sources: loaded.sources, report };
}

export const manifestRecoveryInternalsForTests = {
  aggregate,
  assertSummaryMatches,
  buildRecord,
  highestLod,
  recordKey,
  sortedRecords,
};
