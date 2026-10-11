#!/usr/bin/env node
// PLATEAU（3D都市モデル）のZIPの「目次」だけを読み、建物データの容量を調べる（2026-10-10）。
//
// 目的: 都市ごとのCityGMLのZIPのうち、建物の高さに必要な部分（udx/bldg の .gml）が
//       どれだけの容量かを実数で把握する。あわせて、ZIPの一部分だけを読み出せるかを確かめる。
// やること: 各ZIPの末尾にある目次（セントラルディレクトリ）だけを部分取得し、
//           フォルダーごとの容量を集計する。
// やらないこと: データ本体のダウンロード。PC内のファイルの変更（結果ファイルを2つ書き出すだけ）。
//
// 使い方:  node tools/plateau-size-survey/plateau-bldg-survey.mjs
// 入力:    plateau-bldg-survey-targets.json（同じフォルダー。容量調査の結果JSONでも可）
// 出力:    plateau-bldg-survey-result.json / plateau-bldg-survey-result.csv

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUEST_TIMEOUT_MS = 120_000;
const CONCURRENCY = 3;
const RETRIES = 2;
const TAIL_BYTES = 256 * 1024;
const MAX_DIRECTORY_BYTES = 512 * 1024 * 1024;
const USER_AGENT = "AstroSight-plateau-bldg-survey/1.0 (zip directory survey; no data download)";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ENTRY_SIGNATURE = 0x02014b50;

/** 資源名「CityGML（v4）」から版番号を読む。書かれていなければ 1。 */
export function versionFromResourceName(name) {
  const match = /v\s*([0-9]+)/iu.exec(String(name ?? "").normalize("NFKC"));
  return match ? Number(match[1]) : 1;
}

/** 容量調査の結果から、都市ごとに「最新年度・最新版」のCityGMLを1つずつ選ぶ。 */
export function selectTargets(rows) {
  const best = new Map();
  for (const row of rows ?? []) {
    if (!row?.url) continue;
    const key = row.cityCode || String(row.dataset ?? "").replace(/-20\d{2}$/u, "");
    const candidate = {
      key,
      dataset: String(row.dataset ?? ""),
      title: String(row.title ?? ""),
      cityCode: row.cityCode ?? null,
      year: row.year ?? null,
      version: versionFromResourceName(row.resourceName),
      url: String(row.url),
      bytes: Number.isFinite(row.bytes) ? row.bytes : null,
    };
    const current = best.get(key);
    const newer = !current ||
      (candidate.year ?? 0) > (current.year ?? 0) ||
      ((candidate.year ?? 0) === (current.year ?? 0) && candidate.version > current.version) ||
      ((candidate.year ?? 0) === (current.year ?? 0) && candidate.version === current.version &&
        (candidate.bytes ?? 0) > (current.bytes ?? 0));
    if (newer) best.set(key, candidate);
  }
  return [...best.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** ZIP内のパスを分類する。建物の .gml だけが、高さの算出に必要な部分。 */
export function classifyEntry(name) {
  const normalized = String(name).replaceAll("\\", "/").toLowerCase();
  if (normalized.endsWith("/")) return null;
  const match = /(?:^|\/)udx\/([^/]+)\//u.exec(normalized);
  if (!match) return "other";
  if (match[1] !== "bldg") return `udx/${match[1]}`;
  return normalized.endsWith(".gml") ? "bldg-gml" : "bldg-other";
}

async function fetchRange(url, start, endInclusive) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { Range: `bytes=${start}-${endInclusive}`, "User-Agent": USER_AGENT },
      });
      if (response.status === 200) {
        // 部分取得に応じず全体を返そうとしている。本体を受け取らずに打ち切る。
        controller.abort();
        const error = new Error("range-unsupported");
        error.code = "RANGE_UNSUPPORTED";
        throw error;
      }
      if (response.status !== 206) throw new Error(`HTTP ${response.status}`);
      const total = /\/(\d+)\s*$/u.exec(response.headers.get("content-range") ?? "");
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length !== endInclusive - start + 1) throw new Error("受け取った長さが要求と一致しません");
      return { buffer, totalBytes: total ? Number(total[1]) : null };
    } catch (error) {
      if (error?.code === "RANGE_UNSUPPORTED") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("取得に失敗しました");
}

async function fileSize(url, knownBytes) {
  // 1バイトだけ取得して、全体の大きさと部分取得の可否を同時に確かめる。
  const { totalBytes } = await fetchRange(url, 0, 0);
  const size = totalBytes ?? knownBytes;
  if (!Number.isFinite(size) || size <= 0) throw new Error("ファイルの大きさが分かりません");
  return size;
}

/** 目次の位置と大きさを、ZIPの末尾から読み取る（ZIP64対応）。 */
export async function locateDirectory(size, read) {
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = await read(tailStart, size - 1);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE &&
      index + 22 + tail.readUInt16LE(index + 20) <= tail.length) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIPの末尾（目次の位置情報）が見つかりません");
  let entryCount = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);
  let zip64 = false;
  const locator = eocd - 20;
  if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR_SIGNATURE) {
    const recordOffset = Number(tail.readBigUInt64LE(locator + 8));
    const record = recordOffset >= tailStart && recordOffset + 56 <= size
      ? tail.subarray(recordOffset - tailStart, recordOffset - tailStart + 56)
      : await read(recordOffset, recordOffset + 55);
    if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) throw new Error("ZIP64の位置情報が壊れています");
    entryCount = Number(record.readBigUInt64LE(32));
    directorySize = Number(record.readBigUInt64LE(40));
    directoryOffset = Number(record.readBigUInt64LE(48));
    zip64 = true;
  } else if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64の位置情報が見つかりません");
  }
  if (directoryOffset + directorySize > size) throw new Error("目次の位置がファイルの外を指しています");
  if (directorySize > MAX_DIRECTORY_BYTES) throw new Error("目次が大きすぎます");
  const directory = directoryOffset >= tailStart
    ? tail.subarray(directoryOffset - tailStart, directoryOffset - tailStart + directorySize)
    : null;
  return { entryCount, directorySize, directoryOffset, zip64, directory };
}

/** 目次を読み、分類ごとの個数・圧縮後・展開後の大きさを合計する。 */
export function summarizeDirectory(directory) {
  const categories = {};
  let offset = 0;
  let entries = 0;
  while (offset + 46 <= directory.length) {
    if (directory.readUInt32LE(offset) !== ENTRY_SIGNATURE) break;
    let compressed = directory.readUInt32LE(offset + 20);
    let uncompressed = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const name = directory.toString("utf8", offset + 46, offset + 46 + nameLength);
    // 4GB以上の項目は、拡張欄（ZIP64）に本当の大きさが入る。順番は 展開後 → 圧縮後。
    let extra = offset + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extra);
      const length = directory.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let cursor = extra + 4;
        if (uncompressed === 0xffffffff) { uncompressed = Number(directory.readBigUInt64LE(cursor)); cursor += 8; }
        if (compressed === 0xffffffff) { compressed = Number(directory.readBigUInt64LE(cursor)); }
        break;
      }
      extra += 4 + length;
    }
    const category = classifyEntry(name);
    if (category) {
      const bucket = (categories[category] ??= { files: 0, compressedBytes: 0, uncompressedBytes: 0 });
      bucket.files += 1;
      bucket.compressedBytes += compressed;
      bucket.uncompressedBytes += uncompressed;
    }
    entries += 1;
    offset = extraEnd + commentLength;
  }
  return { entries, categories };
}

/** 1つのZIPを調べる。失敗しても例外にせず、理由を結果に残す。 */
export async function surveyArchive(target) {
  const base = {
    key: target.key, dataset: target.dataset, title: target.title, cityCode: target.cityCode,
    year: target.year, version: target.version, url: target.url, host: hostOf(target.url),
  };
  if (!/\.zip(\?|$)/iu.test(target.url)) {
    return { ...base, status: "not-zip", zipBytes: target.bytes ?? null, message: "ZIP以外の形式のため目次だけを読めません" };
  }
  try {
    const size = await fileSize(target.url, target.bytes);
    const read = async (start, end) => (await fetchRange(target.url, start, end)).buffer;
    const located = await locateDirectory(size, read);
    const directory = located.directory ??
      await read(located.directoryOffset, located.directoryOffset + located.directorySize - 1);
    const summary = summarizeDirectory(directory);
    if (summary.entries !== located.entryCount) {
      return { ...base, status: "error", zipBytes: size, message: `目次の件数が合いません（${summary.entries}/${located.entryCount}）` };
    }
    return {
      ...base, status: "ok", zipBytes: size, zip64: located.zip64,
      entries: summary.entries, directoryBytes: located.directorySize, categories: summary.categories,
    };
  } catch (error) {
    if (error?.code === "RANGE_UNSUPPORTED") {
      return { ...base, status: "range-unsupported", zipBytes: target.bytes ?? null, message: "この配布元は部分取得に応じません" };
    }
    return { ...base, status: "error", zipBytes: target.bytes ?? null, message: error instanceof Error ? error.message : String(error) };
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

export function buildResult(archives) {
  const ok = archives.filter((archive) => archive.status === "ok");
  const totalOf = (category, field) => ok.reduce((total, archive) => total + (archive.categories[category]?.[field] ?? 0), 0);
  const categoryTotals = {};
  for (const archive of ok) {
    for (const [category, bucket] of Object.entries(archive.categories)) {
      const total = (categoryTotals[category] ??= { files: 0, compressedBytes: 0, uncompressedBytes: 0 });
      total.files += bucket.files;
      total.compressedBytes += bucket.compressedBytes;
      total.uncompressedBytes += bucket.uncompressedBytes;
    }
  }
  const hosts = {};
  for (const archive of archives) {
    const host = (hosts[archive.host] ??= { ok: 0, "range-unsupported": 0, "not-zip": 0, error: 0 });
    host[archive.status] += 1;
  }
  const failed = archives.filter((archive) => archive.status !== "ok");
  return {
    generatedAt: new Date().toISOString(),
    targetCount: archives.length,
    readCount: ok.length,
    notReadCount: failed.length,
    notReadZipBytes: failed.reduce((total, archive) => total + (archive.zipBytes ?? 0), 0),
    totals: {
      zipBytes: ok.reduce((total, archive) => total + archive.zipBytes, 0),
      bldgGmlFiles: totalOf("bldg-gml", "files"),
      bldgGmlCompressedBytes: totalOf("bldg-gml", "compressedBytes"),
      bldgGmlUncompressedBytes: totalOf("bldg-gml", "uncompressedBytes"),
      bldgOtherCompressedBytes: totalOf("bldg-other", "compressedBytes"),
      withoutBldg: ok.filter((archive) => !archive.categories["bldg-gml"]).map((archive) => archive.dataset),
    },
    categoryTotals,
    hosts,
    archives,
  };
}

export function toCsv(result) {
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const gb = (bytes) => (Number.isFinite(bytes) ? (bytes / 1024 ** 3).toFixed(3) : "");
  const header = ["dataset", "title", "cityCode", "year", "version", "status", "zipGB", "bldgGmlFiles",
    "bldgGmlCompressedGB", "bldgGmlUncompressedGB", "bldgTextureEtcGB", "message", "url"];
  const lines = result.archives.map((archive) => [
    archive.dataset, archive.title, archive.cityCode, archive.year, archive.version, archive.status,
    gb(archive.zipBytes), archive.categories?.["bldg-gml"]?.files ?? "",
    gb(archive.categories?.["bldg-gml"]?.compressedBytes), gb(archive.categories?.["bldg-gml"]?.uncompressedBytes),
    gb(archive.categories?.["bldg-other"]?.compressedBytes), archive.message ?? "", archive.url,
  ].map(escape).join(","));
  // Excelで文字化けしないようBOMを付ける。
  return `﻿${header.join(",")}\r\n${lines.join("\r\n")}\r\n`;
}

async function runAll(targets, log) {
  const results = new Array(targets.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < targets.length) {
      const index = next;
      next += 1;
      results[index] = await surveyArchive(targets[index]);
      done += 1;
      const archive = results[index];
      const note = archive.status === "ok"
        ? `建物 ${gib(archive.categories["bldg-gml"]?.compressedBytes ?? 0)} / 全体 ${gib(archive.zipBytes)}`
        : `読めませんでした（${archive.message}）`;
      log(`  ${done}/${targets.length} ${archive.dataset}: ${note}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  return results;
}

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

async function loadTargets(scriptDirectory, outputDirectory) {
  const candidates = [
    process.env.PLATEAU_BLDG_TARGETS,
    path.join(scriptDirectory, "plateau-bldg-survey-targets.json"),
    path.join(outputDirectory, "plateau-size-survey-result.json"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    let text;
    try { text = await readFile(candidate, "utf8"); } catch { continue; }
    const parsed = JSON.parse(text.replace(/^﻿/u, ""));
    const targets = Array.isArray(parsed) ? parsed : selectTargets(parsed.rows);
    if (targets.length > 0) return targets;
  }
  throw new Error("調べる対象の一覧（plateau-bldg-survey-targets.json）が見つかりません。ZIPを展開したフォルダーのまま実行してください。");
}

async function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const outputDirectory = process.env.PLATEAU_SURVEY_OUTPUT_DIR || process.cwd();
  console.log("PLATEAUの各ZIPの目次だけを読み、建物データの容量を調べます（データ本体はダウンロードしません）。");
  const targets = await loadTargets(scriptDirectory, outputDirectory);
  console.log(`1/2 ${targets.length} 個のZIPの目次を読んでいます…（途中で閉じないでください）`);
  const result = buildResult(await runAll(targets, console.log));
  console.log("2/2 結果を書き出しています…");
  const jsonPath = path.join(outputDirectory, "plateau-bldg-survey-result.json");
  const csvPath = path.join(outputDirectory, "plateau-bldg-survey-result.csv");
  await writeFile(jsonPath, JSON.stringify(result, null, 1), "utf8");
  await writeFile(csvPath, toCsv(result), "utf8");

  console.log("");
  console.log("===== 結果 =====");
  console.log(`目次を読めたZIP: ${result.readCount} / ${result.targetCount} 個（ZIP全体で ${gib(result.totals.zipBytes)}）`);
  console.log(`建物データ(.gml): ${result.totals.bldgGmlFiles} 個`);
  console.log(`  ダウンロード量（圧縮後）: ${gib(result.totals.bldgGmlCompressedBytes)}`);
  console.log(`  展開後: ${gib(result.totals.bldgGmlUncompressedBytes)}`);
  console.log(`建物の写真など（高さの算出には不要）: ${gib(result.totals.bldgOtherCompressedBytes)}`);
  console.log(`読めなかったZIP: ${result.notReadCount} 個（合計 ${gib(result.notReadZipBytes)}）`);
  console.log("");
  console.log("次の2つのファイルができました。JSONの方を送ってください。");
  console.log(`  ${jsonPath}`);
  console.log(`  ${csvPath}`);
}

const invokedDirectly = Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error("");
    console.error("調査を完了できませんでした。");
    console.error(error instanceof Error ? error.message : String(error));
    console.error("この画面の内容をそのまま送ってください。");
    process.exitCode = 1;
  });
}
