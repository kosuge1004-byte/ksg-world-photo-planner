#!/usr/bin/env node
// PLATEAU（3D都市モデル）の都市ごとのデータ容量を調べる（2026-10-10）。
//
// 目的: 全都市のCityGML（元データ）をPCへ取り込む前に、必要な容量を実数で把握する。
// やること: G空間情報センターの公開カタログ（CKAN API）からPLATEAUのデータセット一覧を
//           取得し、各都市のCityGMLファイルの大きさを集計する。
// やらないこと: データ本体のダウンロード（ファイルの大きさを問い合わせるだけ）。
//               PC内のファイルの変更（結果ファイルを2つ書き出すだけ）。
//
// 使い方:  node tools/plateau-size-survey/plateau-size-survey.mjs
// 出力:    plateau-size-survey-result.json / plateau-size-survey-result.csv（実行した場所）

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CATALOG_API = "https://www.geospatial.jp/ckan/api/3/action/package_search";
const PAGE_ROWS = 200;
const PAGE_INTERVAL_MS = 700;
const REQUEST_TIMEOUT_MS = 30_000;
const SIZE_PROBE_CONCURRENCY = 4;
const USER_AGENT = "AstroSight-plateau-size-survey/1.0 (catalog size survey; no data download)";

/** 「約5.5GB」「915 MB」のような説明文から、バイト数を読み取る。 */
export function approximateBytesFromText(text) {
  if (typeof text !== "string") return null;
  const match = /約?\s*([0-9]+(?:[.,][0-9]+)?)\s*(TB|GB|MB|KB|ＧＢ|ＭＢ|ＫＢ)/iu.exec(text.normalize("NFKC"));
  if (!match) return null;
  const value = Number(match[1].replace(",", ""));
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toUpperCase();
  const factor = unit === "TB" ? 1024 ** 4 : unit === "GB" ? 1024 ** 3 : unit === "MB" ? 1024 ** 2 : 1024;
  return Math.round(value * factor);
}

/** データセット名から、市区町村コード（5桁）と年度を読み取る。読めなければ null。 */
export function cityAndYearFromDatasetName(name) {
  const code = /(?:^|-)(\d{5})(?:-|$)/u.exec(name ?? "");
  const year = /(?:^|-)(20\d{2})(?:-|$)/u.exec(name ?? "");
  return { cityCode: code ? code[1] : null, year: year ? Number(year[1]) : null };
}

/** CityGML（元データ）のファイルか。 */
export function isCityGmlResource(resource) {
  const haystack = `${resource?.name ?? ""} ${resource?.url ?? ""} ${resource?.format ?? ""} ${resource?.description ?? ""}`;
  if (!/citygml|city\s*gml/iu.test(haystack)) return false;
  // 仕様書・目録・変換後データは除く。
  if (/3d\s*tiles|mvt|fbx|obj|gltf|geotiff|オルソ|目録|catalog|仕様|手引/iu.test(`${resource?.name ?? ""} ${resource?.format ?? ""}`) &&
    !/citygml/iu.test(resource?.name ?? "")) return false;
  return /\.(zip|7z)(\?|$)/iu.test(resource?.url ?? "") || /zip|7z/iu.test(resource?.format ?? "");
}

async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json, */*", ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** カタログからPLATEAUのデータセットをすべて取得する。 */
export async function fetchPlateauDatasets(catalogApi = DEFAULT_CATALOG_API, log = () => undefined) {
  const byName = new Map();
  // 検索語を変えて2回集める（片方の検索で漏れても拾えるようにする）。
  for (const query of ["plateau", "3D都市モデル"]) {
    let start = 0;
    let total = Number.POSITIVE_INFINITY;
    while (start < total) {
      const url = `${catalogApi}?q=${encodeURIComponent(query)}&rows=${PAGE_ROWS}&start=${start}`;
      const response = await fetchWithTimeout(url);
      if (!response.ok) throw new Error(`カタログの取得に失敗しました（HTTP ${response.status}）: ${url}`);
      const body = await response.json();
      if (!body?.success || !Array.isArray(body?.result?.results)) {
        throw new Error(`カタログの応答形式が想定と違います: ${url}`);
      }
      total = Number(body.result.count) || 0;
      for (const dataset of body.result.results) {
        const name = String(dataset?.name ?? "");
        const title = String(dataset?.title ?? "");
        if (!/plateau/iu.test(name) && !/PLATEAU/iu.test(title)) continue;
        if (!byName.has(name)) byName.set(name, dataset);
      }
      log(`  「${query}」 ${Math.min(start + PAGE_ROWS, total)} / ${total} 件を確認（PLATEAU: ${byName.size} 件）`);
      start += PAGE_ROWS;
      if (body.result.results.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, PAGE_INTERVAL_MS));
    }
  }
  return [...byName.values()];
}

/** ファイルの大きさを、本体をダウンロードせずに問い合わせる。分からなければ null。 */
export async function probeContentLength(url) {
  try {
    const head = await fetchWithTimeout(url, { method: "HEAD" });
    const length = Number(head.headers.get("content-length"));
    if (head.ok && Number.isFinite(length) && length > 0) return { bytes: length, method: "HEAD" };
  } catch {
    // 次の方法を試す。
  }
  try {
    // HEADに応じないサーバー向け: 先頭1バイトだけ要求し、全体の大きさを応答ヘッダーから読む。
    const ranged = await fetchWithTimeout(url, { headers: { Range: "bytes=0-0" } });
    const total = /\/(\d+)\s*$/u.exec(ranged.headers.get("content-range") ?? "");
    await ranged.body?.cancel().catch(() => undefined);
    if (total) return { bytes: Number(total[1]), method: "Range" };
  } catch {
    // 分からない。
  }
  return null;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

/** データセット一覧から、CityGMLファイルの行を作る（大きさの問い合わせは probe に任せる）。 */
export async function buildSurvey(datasets, probe = probeContentLength, log = () => undefined) {
  const candidates = [];
  for (const dataset of datasets) {
    const { cityCode, year } = cityAndYearFromDatasetName(dataset?.name);
    for (const resource of dataset?.resources ?? []) {
      if (!isCityGmlResource(resource)) continue;
      candidates.push({ dataset, resource, cityCode, year });
    }
  }
  let done = 0;
  const rows = await mapWithConcurrency(candidates, SIZE_PROBE_CONCURRENCY, async ({ dataset, resource, cityCode, year }) => {
    const catalogBytes = Number(resource?.size);
    const described = approximateBytesFromText(`${resource?.description ?? ""} ${resource?.name ?? ""}`);
    let bytes = null;
    let source = "不明";
    if (Number.isFinite(catalogBytes) && catalogBytes > 0) {
      bytes = catalogBytes;
      source = "カタログ記載";
    } else {
      const probed = resource?.url ? await probe(resource.url) : null;
      if (probed) {
        bytes = probed.bytes;
        source = `問い合わせ(${probed.method})`;
      } else if (described) {
        bytes = described;
        source = "説明文の概数";
      }
    }
    done += 1;
    if (done % 20 === 0 || done === candidates.length) log(`  大きさを確認中… ${done} / ${candidates.length}`);
    return {
      dataset: String(dataset?.name ?? ""),
      title: String(dataset?.title ?? ""),
      cityCode,
      year,
      resourceName: String(resource?.name ?? ""),
      url: String(resource?.url ?? ""),
      bytes,
      sizeSource: source,
    };
  });

  // 同じ都市に複数年度がある場合、取り込むのは最新年度だけ。
  const latestYearByCity = new Map();
  for (const row of rows) {
    if (!row.cityCode || row.year === null) continue;
    latestYearByCity.set(row.cityCode, Math.max(latestYearByCity.get(row.cityCode) ?? 0, row.year));
  }
  for (const row of rows) {
    row.latestForCity = !row.cityCode || row.year === null
      ? null
      : latestYearByCity.get(row.cityCode) === row.year;
  }

  const sum = (list) => list.reduce((total, row) => total + (row.bytes ?? 0), 0);
  const latestRows = rows.filter((row) => row.latestForCity === true);
  const unclassified = rows.filter((row) => row.latestForCity === null);
  return {
    generatedAt: new Date().toISOString(),
    datasetCount: datasets.length,
    datasetsWithoutCityGml: datasets
      .filter((dataset) => !(dataset?.resources ?? []).some(isCityGmlResource))
      .map((dataset) => String(dataset?.name ?? "")),
    cityGmlFileCount: rows.length,
    unknownSizeCount: rows.filter((row) => row.bytes === null).length,
    totals: {
      allFilesBytes: sum(rows),
      latestPerCityBytes: sum(latestRows),
      latestPerCityFiles: latestRows.length,
      latestPerCityCities: latestYearByCity.size,
      // 名前から市区町村コード・年度を読めなかったデータセット（旧い命名の都市など）。
      unclassifiedBytes: sum(unclassified),
      unclassifiedFiles: unclassified.length,
    },
    rows,
    // 判定に漏れがあっても後から集計し直せるよう、全データセットのファイル一覧も残す。
    catalogue: datasets.map((dataset) => ({
      name: String(dataset?.name ?? ""),
      title: String(dataset?.title ?? ""),
      resources: (dataset?.resources ?? []).map((resource) => ({
        name: String(resource?.name ?? ""),
        format: String(resource?.format ?? ""),
        size: resource?.size ?? null,
        url: String(resource?.url ?? ""),
        description: String(resource?.description ?? "").slice(0, 160),
      })),
    })),
  };
}

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function toCsv(survey) {
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const header = ["dataset", "title", "cityCode", "year", "latestForCity", "bytes", "GB", "sizeSource", "resourceName", "url"];
  const lines = survey.rows.map((row) => [
    row.dataset, row.title, row.cityCode, row.year, row.latestForCity, row.bytes,
    row.bytes === null ? "" : (row.bytes / 1024 ** 3).toFixed(3), row.sizeSource, row.resourceName, row.url,
  ].map(escape).join(","));
  // Excelで文字化けしないようBOMを付ける。
  return `﻿${header.join(",")}\r\n${lines.join("\r\n")}\r\n`;
}

async function main() {
  const catalogApi = process.env.PLATEAU_CATALOG_API || DEFAULT_CATALOG_API;
  const outputDirectory = process.env.PLATEAU_SURVEY_OUTPUT_DIR || process.cwd();
  console.log("PLATEAUのデータ容量を調べます（データ本体はダウンロードしません）。");
  console.log("1/3 データセットの一覧を取得しています…");
  const datasets = await fetchPlateauDatasets(catalogApi, console.log);
  if (datasets.length === 0) throw new Error("PLATEAUのデータセットが1件も見つかりませんでした。");
  console.log(`2/3 CityGMLファイルの大きさを確認しています…（データセット ${datasets.length} 件）`);
  const survey = await buildSurvey(datasets, probeContentLength, console.log);
  console.log("3/3 結果を書き出しています…");
  const jsonPath = path.join(outputDirectory, "plateau-size-survey-result.json");
  const csvPath = path.join(outputDirectory, "plateau-size-survey-result.csv");
  await writeFile(jsonPath, JSON.stringify(survey, null, 1), "utf8");
  await writeFile(csvPath, toCsv(survey), "utf8");

  console.log("");
  console.log("===== 結果 =====");
  console.log(`PLATEAUのデータセット: ${survey.datasetCount} 件`);
  console.log(`CityGMLファイル: ${survey.cityGmlFileCount} 個（大きさ不明 ${survey.unknownSizeCount} 個）`);
  console.log(`都市ごとの最新年度だけ: ${gib(survey.totals.latestPerCityBytes)}（${survey.totals.latestPerCityCities} 都市・${survey.totals.latestPerCityFiles} 個）`);
  console.log(`都市・年度を名前から読めなかった分: ${gib(survey.totals.unclassifiedBytes)}（${survey.totals.unclassifiedFiles} 個）`);
  console.log(`全ファイルの合計（旧年度を含む）: ${gib(survey.totals.allFilesBytes)}`);
  console.log(`CityGMLが見つからなかったデータセット: ${survey.datasetsWithoutCityGml.length} 件`);
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
