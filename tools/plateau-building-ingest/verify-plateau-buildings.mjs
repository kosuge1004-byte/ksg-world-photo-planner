#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { inspectStoredBuildingFile } from "./manifestRecovery.mjs";

const REPORT_NAME = "verification.json";
const PROGRESS_NAME = "verification-progress.json";
const STANDARD_CONCURRENCY = 32;
const DEEP_CONCURRENCY = 2;

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const recordKey = (record) => `${record.dataset}\n${record.entry}`;

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.new-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, JSON.stringify(value, null, 1), "utf8");
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(file, { force: true });
      await rename(temporary, file);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  await rm(temporary, { force: true }).catch(() => {});
  throw lastError;
}

async function readManifest(file) {
  const records = [];
  const errors = [];
  const keys = new Set();
  const input = createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (typeof record?.dataset !== "string" || typeof record?.entry !== "string") {
          errors.push(`manifest ${lineNumber}: dataset/entry が不正です`);
          continue;
        }
        const key = recordKey(record);
        if (keys.has(key)) errors.push(`manifest ${lineNumber}: 重複 ${key}`);
        keys.add(key);
        records.push(record);
      } catch (error) {
        errors.push(`manifest ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return { records, errors };
}

function aggregate(records) {
  const sum = (field) => records.reduce((total, record) => total + (Number(record[field]) || 0), 0);
  const lod = {};
  for (const record of records) {
    for (const [level, count] of Object.entries(record.maxLod ?? {})) {
      lod[level] = (lod[level] ?? 0) + (Number(count) || 0);
    }
  }
  return {
    files: records.length,
    datasetsWithData: new Set(records.map((record) => record.dataset)).size,
    buildings: sum("buildings"),
    written: sum("written"),
    withoutGeometry: sum("withoutGeometry"),
    badCoordinatePolygons: sum("badCoordinatePolygons"),
    buildingsByHighestLod: lod,
    downloadedBytes: sum("downloadedBytes"),
    sourceBytes: sum("sourceBytes"),
    storedBytes: sum("storedBytes"),
  };
}

function compareSummary(summary, actual, errors) {
  for (const field of [
    "files", "datasetsWithData", "buildings", "written", "withoutGeometry",
    "badCoordinatePolygons", "downloadedBytes", "sourceBytes", "storedBytes",
  ]) {
    if (summary[field] !== actual[field]) errors.push(`summary.${field}: ${summary[field]} / 実体 ${actual[field]}`);
  }
  if (!sameJson(summary.buildingsByHighestLod, actual.buildingsByHighestLod)) {
    errors.push("summary.buildingsByHighestLod がmanifestの合計と一致しません");
  }
}

function sameBbox(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === 4 && right.length === 4 &&
    left.every((value, index) => Math.abs(value - right[index]) <= 1e-10);
}

async function listStoredBuildingFiles(directory, root = directory, files = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await listStoredBuildingFiles(absolute, root, files);
    else if (entry.isFile() && entry.name.endsWith(".gml.ndjson.gz")) {
      files.push(path.relative(root, absolute).replaceAll("\\", "/").toLowerCase());
    }
  }
  return files;
}

export async function verifyPlateauBuildings({ outputDirectory, targets, deep = false, log = console.log }) {
  const startedAt = new Date().toISOString();
  const manifestPath = path.join(outputDirectory, "manifest.ndjson");
  const summary = JSON.parse(await readFile(path.join(outputDirectory, "summary.json"), "utf8"));
  const { records, errors } = await readManifest(manifestPath);
  const expectedByDataset = new Map(targets.map((target) => [target.dataset, target.expectedFiles ?? 0]));
  const targetByDataset = new Map(targets.map((target) => [target.dataset, target]));
  const actualByDataset = new Map();
  for (const record of records) actualByDataset.set(record.dataset, (actualByDataset.get(record.dataset) ?? 0) + 1);
  for (const [dataset, expected] of expectedByDataset) {
    const actual = actualByDataset.get(dataset) ?? 0;
    if (actual !== expected) errors.push(`${dataset}: 記録 ${actual} / 想定 ${expected}`);
  }
  for (const dataset of actualByDataset.keys()) {
    if (!expectedByDataset.has(dataset)) errors.push(`対象外データセットがmanifestにあります: ${dataset}`);
  }
  const expectedFiles = [...expectedByDataset.values()].reduce((total, count) => total + count, 0);
  if (records.length !== expectedFiles) errors.push(`manifest合計 ${records.length} / 想定 ${expectedFiles}`);
  if (summary.complete !== true) errors.push("summary.complete が true ではありません");
  if (summary.expectedFiles !== expectedFiles) errors.push(`summary.expectedFiles ${summary.expectedFiles} / 想定 ${expectedFiles}`);
  compareSummary(summary, aggregate(records), errors);

  const root = path.resolve(outputDirectory);
  const physical = records.filter((record) => record.file);
  const fileOwners = new Map();
  for (const record of physical) {
    const normalized = String(record.file).replaceAll("\\", "/").toLowerCase();
    const owner = fileOwners.get(normalized);
    if (owner) errors.push(`同じ保存ファイルを複数記録が参照しています: ${owner} / ${recordKey(record)}`);
    else fileOwners.set(normalized, recordKey(record));
  }
  let completed = 0;
  let totalPhysicalBytes = 0;
  let next = 0;
  const startedMs = Date.now();
  const errorLimit = 1000;
  let suppressedErrors = 0;
  const addError = (message) => {
    if (errors.length < errorLimit) errors.push(message);
    else suppressedErrors += 1;
  };
  let progressQueue = Promise.resolve();
  const writeProgress = async (force = false) => {
    if (!force && completed % 100 !== 0) return;
    const snapshot = {
      status: "running", mode: deep ? "deep" : "standard", startedAt,
      updatedAt: new Date().toISOString(), checkedFiles: completed, totalFiles: physical.length,
      percent: physical.length ? Math.floor(completed * 10000 / physical.length) / 100 : 100,
      errorCount: errors.length + suppressedErrors,
    };
    progressQueue = progressQueue.then(() =>
      writeFile(path.join(outputDirectory, PROGRESS_NAME), JSON.stringify(snapshot, null, 1), "utf8")
    ).catch(() => {});
    await progressQueue;
  };
  await writeProgress(true);
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= physical.length) return;
      const record = physical[index];
      try {
        if (typeof record.file !== "string" || !/^buildings\/[a-z0-9._-]+\/[^/\\]+\.gml\.ndjson\.gz$/iu.test(record.file)) {
          throw new Error("保存相対パスが不正です");
        }
        const file = path.resolve(root, record.file);
        if (!file.startsWith(`${root}${path.sep}`)) throw new Error("保存先の外を参照しています");
        const info = await stat(file);
        if (!info.isFile()) throw new Error("通常ファイルではありません");
        if (info.size !== record.storedBytes) throw new Error(`容量 ${info.size} / 記録 ${record.storedBytes}`);
        totalPhysicalBytes += info.size;
        if (deep) {
          const target = targetByDataset.get(record.dataset);
          if (!target) throw new Error("対象データセットがありません");
          const inspected = await inspectStoredBuildingFile(file, { target, entry: { name: record.entry } });
          if (inspected.written !== record.written) throw new Error(`建物数 ${inspected.written} / 記録 ${record.written}`);
          if (inspected.badCoordinatePolygons !== record.badCoordinatePolygons) {
            throw new Error(`不正座標面 ${inspected.badCoordinatePolygons} / 記録 ${record.badCoordinatePolygons}`);
          }
          if (!sameBbox(inspected.bbox, record.bbox)) throw new Error("範囲が記録と一致しません");
          if (!sameJson(inspected.maxLod, record.maxLod)) throw new Error("LOD内訳が記録と一致しません");
        }
      } catch (error) {
        addError(`${record.dataset} ${record.entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
      completed += 1;
      await writeProgress(false);
      if (completed % 1000 === 0 || index === physical.length - 1) {
        const percent = physical.length ? (completed * 100 / physical.length).toFixed(1) : "100.0";
        log(`検査 ${completed}/${physical.length} (${percent}%)`);
      }
    }
  };
  await Promise.all(Array.from({ length: deep ? DEEP_CONCURRENCY : STANDARD_CONCURRENCY }, worker));
  await progressQueue;
  if (totalPhysicalBytes !== summary.storedBytes) addError(`実ファイル合計 ${totalPhysicalBytes} / summary ${summary.storedBytes}`);
  const storedFiles = await listStoredBuildingFiles(path.join(root, "buildings"));
  for (const relativeBelowBuildings of storedFiles) {
    const relative = `buildings/${relativeBelowBuildings}`;
    if (!fileOwners.has(relative)) addError(`manifestから参照されていない保存ファイルがあります: ${relative}`);
  }
  if (storedFiles.length !== physical.length) {
    addError(`保存ファイル合計 ${storedFiles.length} / manifest参照 ${physical.length}`);
  }
  const result = {
    status: errors.length + suppressedErrors === 0 ? "complete" : "failed",
    mode: deep ? "deep" : "standard", startedAt, completedAt: new Date().toISOString(),
    elapsedMilliseconds: Date.now() - startedMs, manifestRecords: records.length,
    expectedRecords: expectedFiles, physicalFiles: physical.length, physicalBytes: totalPhysicalBytes,
    errorCount: errors.length + suppressedErrors, errors, suppressedErrors,
  };
  await writeJsonAtomic(path.join(outputDirectory, REPORT_NAME), result);
  await writeJsonAtomic(path.join(outputDirectory, PROGRESS_NAME), { ...result, reportPath: path.join(outputDirectory, REPORT_NAME) });
  if (result.status !== "complete") throw new Error(`PLATEAUデータ検査で ${result.errorCount} 件の問題が見つかりました`);
  log(`検査完了: ${records.length}記録、${physical.length}実ファイル、問題0件`);
  return result;
}

async function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const deep = process.argv.includes("--deep");
  const explicitDirectory = process.argv.slice(2).find((argument) => argument !== "--deep");
  let outputDirectory = explicitDirectory || process.env.PLATEAU_BUILDING_OUTPUT_DIR;
  if (!outputDirectory) {
    const settings = JSON.parse(await readFile(path.join(scriptDirectory, "ingest-settings.json"), "utf8"));
    outputDirectory = settings.outputDirectory;
  }
  if (!outputDirectory || !path.isAbsolute(outputDirectory)) throw new Error("検査対象の保存先が設定されていません");
  const targetsPath = process.env.PLATEAU_BUILDING_TARGETS || path.join(scriptDirectory, "plateau-building-ingest-targets.json");
  const parsed = JSON.parse((await readFile(targetsPath, "utf8")).replace(/^\ufeff/u, ""));
  const targets = Array.isArray(parsed) ? parsed : parsed.archives;
  console.log(deep ? "PLATEAU建物データを全展開検査します。" : "PLATEAU建物データの記録と実体を検査します。");
  console.log(`検査先: ${outputDirectory}`);
  await verifyPlateauBuildings({ outputDirectory: path.resolve(outputDirectory), targets, deep });
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
