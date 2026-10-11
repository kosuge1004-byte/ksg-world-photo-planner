#!/usr/bin/env node
// PLATEAU（3D都市モデル）の建物データを取り込む（2026-10-10）。
//
// やること: 各都市のCityGMLのZIPから、建物のファイル（udx/bldg の .gml）だけを取り出し、
//           建物ごとの「輪郭・上を向いた面・高さの範囲」を抜き出して保存する。
// やらないこと: ZIP全体のダウンロード（地形・写真などは取らない）。元の .gml の保存。
//               保存先フォルダー以外への書き込み（前回の保存先の控えを除く）。
// 途中で止めても、もう一度実行すれば続きから再開する。失敗した分だけやり直す。
//
// 使い方:  node plateau-building-ingest.mjs [保存先フォルダー]
// 保存先:  <保存先>/buildings/<データセット名>/<元のファイル名>.ndjson.gz（1行=建物1件）
//          <保存先>/manifest.ndjson（取り込み済みファイルの一覧。再開にも使う）
//          <保存先>/summary.json / failures.json / SOURCE.txt

import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createBuildingExtractor } from "./cityGmlBuildings.mjs";
import {
  appendManifestRecord,
  loadManifestRecords,
  recoverCompletedManifest,
  writeCanonicalManifests,
} from "./manifestRecovery.mjs";
import { listEntries, RangeUnsupportedError, readEntry, UnsupportedEntryError } from "./remoteZip.mjs";
import { verifyPlateauBuildings } from "./verify-plateau-buildings.mjs";
import {
  buildingEntryHasDuplicateBasename,
  duplicateBuildingBasenames,
  storedBuildingRelativePath,
} from "./storedBuildingPath.mjs";

const SCHEMA_VERSION = 1;
const ENTRY_CONCURRENCY = 4;
const RETRIES = 3;
const MINIMUM_FREE_BYTES = 2 * 1024 ** 3;
const PROGRESS_EVERY_FILES = 25;

class InvalidSourceError extends Error {}

export function isBuildingGml(name) {
  return /(?:^|\/)udx\/bldg\/[^/]+\.gml$/iu.test(String(name).replaceAll("\\", "/"));
}

/** ファイル名の先頭の数字（地域メッシュコード）。無ければ null。 */
export function meshCodeFromEntry(name) {
  const match = /^(\d{6,10})_/u.exec(path.posix.basename(String(name).replaceAll("\\", "/")));
  return match ? match[1] : null;
}

/** 容量調査（建物）の結果から、取り込む対象を選ぶ。 */
export function selectIngestTargets(archives) {
  const withBuildings = (archives ?? []).filter((archive) => archive.status === "ok" && (archive.categories?.["bldg-gml"]?.files ?? 0) > 0);
  // 東京23区の一括版は、23区すべてに新しい区ごとの版がそろっているときだけ外す（古い建物を混ぜないため）。
  const wardYears = new Map();
  for (const archive of withBuildings) {
    if (/^131(0[1-9]|1\d|2[0-3])$/u.test(archive.cityCode ?? "")) wardYears.set(archive.cityCode, archive.year ?? 0);
  }
  const allWards = wardYears.size === 23;
  return withBuildings
    .filter((archive) => !(allWards && /^plateau-tokyo23ku-20\d{2}$/u.test(archive.dataset) &&
      [...wardYears.values()].every((year) => year > (archive.year ?? 0))))
    .map((archive) => ({
      dataset: archive.dataset, title: archive.title, cityCode: archive.cityCode ?? null, year: archive.year ?? null,
      version: archive.version ?? null, url: archive.url,
      // 市区町村の通常版ではないもの（実証事業・特定地区の詳細版）。使うかどうかは後の段階で決められるよう印を付ける。
      special: !archive.cityCode,
      expectedFiles: archive.categories["bldg-gml"].files,
      expectedCompressedBytes: archive.categories["bldg-gml"].compressedBytes,
    }));
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

async function withRetries(task, delayMs = 2000) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try { return await task(); } catch (error) {
      if (error instanceof UnsupportedEntryError || error instanceof InvalidSourceError || error instanceof RangeUnsupportedError) throw error;
      lastError = error;
      await sleep(delayMs * (attempt + 1));
    }
  }
  throw lastError;
}

/** 1つの建物ファイルを取り込む。成功したら manifest に書く1行分の情報を返す。 */
export async function ingestEntry(target, archive, entry, outputDirectory, disambiguate = false) {
  const relative = storedBuildingRelativePath(target.dataset, entry.name, disambiguate);
  const finalPath = path.join(outputDirectory, relative);
  const partialPath = `${finalPath}.partial`;
  await mkdir(path.dirname(finalPath), { recursive: true });
  const gzip = zlib.createGzip({ level: 6 });
  const file = createWriteStream(partialPath);
  const finished = new Promise((resolve, reject) => { file.on("finish", resolve); file.on("error", reject); gzip.on("error", reject); });
  gzip.pipe(file);
  let needsDrain = false;
  let south = Infinity; let west = Infinity; let north = -Infinity; let east = -Infinity;
  const write = (value) => { if (!gzip.write(`${JSON.stringify(value)}\n`)) needsDrain = true; };
  write({
    type: "header", schema: SCHEMA_VERSION, dataset: target.dataset, year: target.year, cityCode: target.cityCode,
    entry: entry.name, heightDatum: "source-orthometric", coordinateOrder: "lat,lon,height",
    source: "3D都市モデル（Project PLATEAU）国土交通省",
  });
  const extractor = createBuildingExtractor((building) => {
    if (building.b[0] < south) south = building.b[0];
    if (building.b[1] < west) west = building.b[1];
    if (building.b[2] > north) north = building.b[2];
    if (building.b[3] > east) east = building.b[3];
    write(building);
  });
  try {
    await readEntry(target.url, archive, entry, (chunk) => {
      extractor.write(chunk);
      if (!needsDrain) return undefined;
      needsDrain = false;
      return new Promise((resolve) => gzip.once("drain", resolve));
    });
    const stats = extractor.end();
    if (stats.encoding !== null && stats.encoding !== "UTF-8") throw new InvalidSourceError(`文字コードが想定外です（${stats.encoding}）`);
    if (stats.incomplete) throw new InvalidSourceError("XMLが途中で終わっています");
    if (stats.srsNames.some((name) => !/(?:EPSG|epsg)[/:]+(?:0\/)?6697$/u.test(name))) {
      throw new InvalidSourceError(`座標系が想定外です（${stats.srsNames.join(", ")}）`);
    }
    gzip.end();
    await finished;
    const record = {
      dataset: target.dataset, year: target.year, cityCode: target.cityCode, special: target.special,
      entry: entry.name, mesh: meshCodeFromEntry(entry.name), file: stats.written > 0 ? relative : null,
      bbox: stats.written > 0 ? [south, west, north, east] : null,
      buildings: stats.buildings, written: stats.written, withoutGeometry: stats.withoutGeometry,
      badCoordinatePolygons: stats.badCoordinatePolygons, maxLod: stats.maxLod,
      sourceBytes: entry.uncompressedSize, downloadedBytes: entry.compressedSize, crc: entry.crc >>> 0,
    };
    if (stats.written > 0) {
      await rename(partialPath, finalPath);
      record.storedBytes = (await stat(finalPath)).size;
    } else {
      await rm(partialPath, { force: true });
      record.storedBytes = 0;
    }
    return record;
  } catch (error) {
    gzip.destroy();
    file.destroy();
    await rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function runIngest({
  targets,
  outputDirectory,
  log = console.log,
  freeBytes = defaultFreeBytes,
  retryDelayMs = 2000,
  additionalManifestPaths = [],
}) {
  await mkdir(outputDirectory, { recursive: true });
  let loaded = await loadManifestRecords(outputDirectory, additionalManifestPaths);
  let done = loaded.records;
  const expectedFiles = targets.reduce((total, target) => total + (target.expectedFiles ?? 0), 0);
  let previousSummary = null;
  try { previousSummary = JSON.parse(await readFile(path.join(outputDirectory, "summary.json"), "utf8")); } catch { /* first run */ }
  if (
    previousSummary?.complete === true &&
    previousSummary.files === previousSummary.expectedFiles &&
    previousSummary.expectedFiles === expectedFiles &&
    done.size < expectedFiles
  ) {
    log(`完成データの記録が${expectedFiles - done.size}件不足しているため、自動修復します。`);
    const recovered = await recoverCompletedManifest({
      targets,
      outputDirectory,
      additionalManifestPaths,
      log,
    });
    done = new Map(recovered.records.map((record) => [`${record.dataset}\n${record.entry}`, record]));
    log(`記録を${done.size}件に修復しました。元データの再ダウンロードはありません。`);
  }
  // A few special PLATEAU archives contain different entry paths with the
  // same basename. Older runs mapped both records to one output file. Mark
  // only those colliding entries for re-ingest with deterministic hash names.
  const recordKeysByFile = new Map();
  for (const [key, record] of done) {
    if (!record.file) continue;
    const normalized = String(record.file).replaceAll("\\", "/").toLowerCase();
    const keys = recordKeysByFile.get(normalized) ?? [];
    keys.push(key);
    recordKeysByFile.set(normalized, keys);
  }
  let collisionRecords = 0;
  const obsoleteCollisionFiles = new Set();
  for (const [normalizedFile, keys] of recordKeysByFile) {
    if (keys.length < 2) continue;
    obsoleteCollisionFiles.add(normalizedFile);
    for (const key of keys) {
      done.delete(key);
      collisionRecords += 1;
    }
  }
  if (collisionRecords > 0) log(`保存名が重複していた${collisionRecords}件だけを自動修復します。`);
  // 記録はあるのに実体が無いファイルは、取り込み直す。
  for (const [key, record] of [...done]) {
    if (!record.file) continue;
    try { await stat(path.join(outputDirectory, record.file)); } catch { done.delete(key); }
  }
  const reuseCompletedData = previousSummary?.complete === true &&
    previousSummary.expectedFiles === expectedFiles && done.size === expectedFiles;
  let manifestQueue = Promise.resolve();
  const appendManifest = (record) => {
    manifestQueue = manifestQueue.then(() => appendManifestRecord(outputDirectory, record));
    return manifestQueue;
  };
  const failures = [];
  let stoppedForDisk = false;
  let newFiles = 0;

  for (let index = 0; index < targets.length && !stoppedForDisk && !reuseCompletedData; index += 1) {
    const target = targets[index];
    const label = `${index + 1}/${targets.length} ${target.dataset}`;
    const completedForTarget = [...done.values()].filter((record) => record.dataset === target.dataset).length;
    if (target.expectedFiles !== undefined && completedForTarget === target.expectedFiles) {
      log(`${label}: 取り込み済み（${completedForTarget} ファイル）`);
      continue;
    }
    let archive;
    try {
      archive = await withRetries(() => listEntries(target.url), retryDelayMs);
    } catch (error) {
      failures.push({ dataset: target.dataset, entry: null, message: error instanceof Error ? error.message : String(error) });
      log(`${label}: 一覧を読めませんでした（${failures.at(-1).message}）`);
      continue;
    }
    const entries = archive.entries.filter((entry) => isBuildingGml(entry.name));
    const duplicateBasenames = duplicateBuildingBasenames(entries);
    const todo = entries.filter((entry) => !done.has(`${target.dataset}\n${entry.name}`));
    if (todo.length === 0) { log(`${label}: 取り込み済み（${entries.length} ファイル）`); continue; }
    log(`${label}: ${todo.length} ファイルを取り込みます（済み ${entries.length - todo.length}）`);
    let next = 0;
    let finishedCount = 0;
    let failedCount = 0;
    const worker = async () => {
      while (next < todo.length && !stoppedForDisk) {
        const entry = todo[next];
        next += 1;
        if ((await freeBytes(outputDirectory)) < MINIMUM_FREE_BYTES) { stoppedForDisk = true; break; }
        try {
          const record = await withRetries(() => ingestEntry(
            target,
            archive,
            entry,
            outputDirectory,
            buildingEntryHasDuplicateBasename(entry, duplicateBasenames)
          ), retryDelayMs);
          await appendManifest(record);
          done.set(`${target.dataset}\n${entry.name}`, record);
          newFiles += 1;
        } catch (error) {
          failedCount += 1;
          failures.push({ dataset: target.dataset, entry: entry.name, message: error instanceof Error ? error.message : String(error) });
        }
        finishedCount += 1;
        if (finishedCount % PROGRESS_EVERY_FILES === 0 && finishedCount < todo.length) log(`    ${finishedCount}/${todo.length} ファイル`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(ENTRY_CONCURRENCY, todo.length) }, worker));
    if (failedCount > 0) log(`    失敗 ${failedCount} ファイル`);
  }
  await manifestQueue;

  const wanted = new Set(targets.map((target) => target.dataset));
  const records = [...done.values()].filter((record) => wanted.has(record.dataset));
  // Remove the old basename-only file after all colliding entries have been
  // written to their unique hash-named paths. Only generated building files
  // below this output root can ever be removed here.
  const activeFiles = new Set(records
    .filter((record) => typeof record.file === "string")
    .map((record) => record.file.replaceAll("\\", "/").toLowerCase()));
  const outputRoot = path.resolve(outputDirectory);
  for (const relative of obsoleteCollisionFiles) {
    if (activeFiles.has(relative)) continue;
    if (!/^buildings\/[a-z0-9._-]+\/[^/\\]+\.gml\.ndjson\.gz$/iu.test(relative)) continue;
    const obsolete = path.resolve(outputRoot, relative);
    if (!obsolete.startsWith(`${outputRoot}${path.sep}`)) continue;
    await rm(obsolete, { force: true });
  }
  const sum = (field) => records.reduce((total, record) => total + (record[field] ?? 0), 0);
  const maxLod = {};
  for (const record of records) for (const [level, count] of Object.entries(record.maxLod ?? {})) maxLod[level] = (maxLod[level] ?? 0) + count;
  await writeCanonicalManifests(outputDirectory, records, { keepRootBackup: true });
  const summary = {
    generatedAt: new Date().toISOString(), schema: SCHEMA_VERSION,
    complete: failures.length === 0 && !stoppedForDisk && records.length === expectedFiles,
    stoppedForDisk, datasets: targets.length, datasetsWithData: new Set(records.map((record) => record.dataset)).size,
    files: records.length, expectedFiles, newFilesThisRun: newFiles,
    buildings: sum("buildings"), written: sum("written"), withoutGeometry: sum("withoutGeometry"),
    badCoordinatePolygons: sum("badCoordinatePolygons"), buildingsByHighestLod: maxLod,
    downloadedBytes: sum("downloadedBytes"), sourceBytes: sum("sourceBytes"), storedBytes: sum("storedBytes"),
    failureCount: failures.length,
  };
  await writeFile(path.join(outputDirectory, "summary.json"), JSON.stringify(summary, null, 1), "utf8");
  await writeFile(path.join(outputDirectory, "failures.json"), JSON.stringify(failures, null, 1), "utf8");
  await writeFile(path.join(outputDirectory, "SOURCE.txt"), [
    "このフォルダーの建物データは、次の公開データから建物の形と高さだけを抜き出したものです。",
    "出典: 3D都市モデル（Project PLATEAU）国土交通省  https://www.mlit.go.jp/plateau/",
    "高さは元データの値（標高）のまま、座標は元データの値（緯度・経度）のまま保存しています。",
    "", "取り込んだデータセット:", ...targets.map((target) => `- ${target.title}（${target.dataset}）`), "",
  ].join("\r\n"), "utf8");
  return { summary, failures };
}

async function defaultFreeBytes(directory) {
  try {
    const info = await statfs(directory);
    return Number(info.bavail) * Number(info.bsize);
  } catch { return Infinity; }
}

async function chooseOutputDirectory(scriptDirectory) {
  const given = process.argv[2] || process.env.PLATEAU_BUILDING_OUTPUT_DIR;
  if (given) return path.resolve(given);
  const settingsPath = path.join(scriptDirectory, "ingest-settings.json");
  let previous = null;
  try { previous = JSON.parse(await readFile(settingsPath, "utf8")).outputDirectory ?? null; } catch { /* 初回 */ }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("保存先のフォルダーを入力して Enter を押してください。（例: D:\\plateau-buildings）");
    if (previous) console.log(`何も入力せずに Enter を押すと、前回と同じ場所を使います: ${previous}`);
    const answer = (await prompt.question("> ")).trim().replace(/^"(.*)"$/u, "$1");
    const chosen = answer || previous;
    if (!chosen) throw new Error("保存先が入力されませんでした。");
    if (!path.isAbsolute(chosen)) throw new Error("保存先は、ドライブ名から始まる場所で入力してください。（例: D:\\plateau-buildings）");
    await writeFile(settingsPath, JSON.stringify({ outputDirectory: chosen }, null, 1), "utf8").catch(() => {});
    return chosen;
  } finally {
    prompt.close();
  }
}

async function additionalManifestPaths(scriptDirectory) {
  const configured = [];
  const fromEnvironment = process.env.PLATEAU_MANIFEST_IMPORTS?.trim();
  if (fromEnvironment) configured.push(...fromEnvironment.split(path.delimiter));
  try {
    const settings = JSON.parse(await readFile(path.join(scriptDirectory, "ingest-settings.json"), "utf8"));
    if (Array.isArray(settings.manifestImports)) configured.push(...settings.manifestImports);
  } catch { /* optional */ }
  return [...new Set(configured
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => path.resolve(value.trim()))
    .filter((value) => path.isAbsolute(value)))];
}

async function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  console.log("PLATEAUの建物データを取り込みます（建物のファイルだけを取り出します）。");
  const targetsPath = process.env.PLATEAU_BUILDING_TARGETS || path.join(scriptDirectory, "plateau-building-ingest-targets.json");
  let parsed;
  try { parsed = JSON.parse((await readFile(targetsPath, "utf8")).replace(/^\ufeff/u, "")); } catch {
    throw new Error("取り込む対象の一覧（plateau-building-ingest-targets.json）が見つかりません。ZIPを展開したフォルダーのまま実行してください。");
  }
  const targets = Array.isArray(parsed) ? parsed : selectIngestTargets(parsed.archives);
  const outputDirectory = await chooseOutputDirectory(scriptDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const expected = targets.reduce((total, target) => total + (target.expectedCompressedBytes ?? 0), 0);
  console.log(`保存先: ${outputDirectory}`);
  console.log(`対象: ${targets.length} データセット、ダウンロード量の見込み ${gib(expected)}`);
  console.log(`保存先の空き容量: ${gib(await defaultFreeBytes(outputDirectory))}`);
  console.log("途中で閉じても、もう一度実行すれば続きから再開します。");
  console.log("");
  const { summary, failures } = await runIngest({
    targets,
    outputDirectory,
    additionalManifestPaths: await additionalManifestPaths(scriptDirectory),
  });

  if (summary.complete) {
    console.log("取り込み結果を自動検査します。");
    await verifyPlateauBuildings({ outputDirectory, targets, deep: false });
    console.log("全保存ファイルを展開する完全検査を自動実行します。時間がかかりますが操作は不要です。");
    await verifyPlateauBuildings({ outputDirectory, targets, deep: true });
  }

  console.log("");
  console.log("===== 結果 =====");
  console.log(`取り込み済みファイル: ${summary.files} / ${summary.expectedFiles} 個（今回 ${summary.newFilesThisRun} 個）`);
  console.log(`建物: ${summary.written} 件（形状が無く保存しなかった建物 ${summary.withoutGeometry} 件）`);
  console.log(`  最も詳しい形状の内訳: ${Object.entries(summary.buildingsByHighestLod).filter(([, count]) => count > 0).map(([level, count]) => `LOD${level} ${count} 件`).join("、")}`);
  console.log(`座標を読めなかった面: ${summary.badCoordinatePolygons} 個`);
  console.log(`ダウンロード量: ${gib(summary.downloadedBytes)}　保存した量: ${gib(summary.storedBytes)}`);
  if (summary.stoppedForDisk) console.log("保存先の空き容量が残り少ないため、途中で止めました。空きを増やして、もう一度実行してください。");
  if (failures.length > 0) {
    console.log(`失敗: ${failures.length} 件。もう一度実行すると、失敗した分だけやり直します。`);
    for (const failure of failures.slice(0, 10)) console.log(`  ${failure.dataset} ${failure.entry ?? ""}: ${failure.message}`);
  } else if (!summary.stoppedForDisk) {
    console.log("すべて取り込みました。");
  }
  console.log("");
  console.log("保存先に summary.json、failures.json、verification.json を保存しました。");
}

const invokedDirectly = Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error("");
    console.error("取り込みを完了できませんでした。");
    console.error(error instanceof Error ? error.message : String(error));
    console.error("この画面の内容をそのまま送ってください。");
    process.exitCode = 1;
  });
}
