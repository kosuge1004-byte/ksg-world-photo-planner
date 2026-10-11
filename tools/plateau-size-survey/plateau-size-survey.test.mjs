// PLATEAU容量調査の道具: 模擬のカタログとファイル置き場で、最初から最後まで動かして確認する。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  approximateBytesFromText,
  buildSurvey,
  cityAndYearFromDatasetName,
  isCityGmlResource,
} from "./plateau-size-survey.mjs";

const GB = 1024 ** 3;

test("reads sizes written in descriptions, city codes and years from dataset names", () => {
  assert.equal(approximateBytesFromText("CityGML（v2） 約5.5GB"), Math.round(5.5 * GB));
  assert.equal(approximateBytesFromText("約 915 MB"), 915 * 1024 ** 2);
  assert.equal(approximateBytesFromText("１．２ＧＢ"), Math.round(1.2 * GB));
  assert.equal(approximateBytesFromText("サイズ記載なし"), null);
  assert.deepEqual(cityAndYearFromDatasetName("plateau-13102-chuo-ku-2023"), { cityCode: "13102", year: 2023 });
  assert.deepEqual(cityAndYearFromDatasetName("plateau-tokyo23ku-2022"), { cityCode: null, year: 2022 });
  assert.deepEqual(cityAndYearFromDatasetName("plateau-tokyo23ku"), { cityCode: null, year: null });
});

test("picks only the CityGML archives", () => {
  assert.equal(isCityGmlResource({ name: "CityGML（v2）", url: "https://x/13100_tokyo23-ku_2022_citygml_1_2_op.zip", format: "ZIP" }), true);
  assert.equal(isCityGmlResource({ name: "3D Tiles, MVT（v2）", url: "https://x/13100_3dtiles-mvt_1_2_op.zip", format: "ZIP" }), false);
  assert.equal(isCityGmlResource({ name: "データ目録（v2）", url: "https://x/13100_catalog.xlsx", format: "XLSX" }), false);
  assert.equal(isCityGmlResource({ name: "GeoTIFF", url: "https://x/ortho.7z", format: "7z" }), false);
});

test("totals use only the newest year per city; unknown sizes are counted, never guessed", async () => {
  const datasets = [
    { name: "plateau-13102-chuo-ku-2022", title: "中央区（2022年度）", resources: [{ name: "CityGML", url: "https://f/a_citygml.zip", format: "ZIP", size: 2 * GB }] },
    { name: "plateau-13102-chuo-ku-2023", title: "中央区（2023年度）", resources: [{ name: "CityGML", url: "https://f/b_citygml.zip", format: "ZIP" }, { name: "3D Tiles", url: "https://f/b_3dtiles.zip", format: "ZIP", size: 9 * GB }] },
    { name: "plateau-27100-osaka-shi-2024", title: "大阪市", resources: [{ name: "CityGML 約4GB", url: "https://f/c_citygml.zip", format: "ZIP" }] },
    { name: "plateau-tokyo23ku", title: "東京都23区", resources: [{ name: "CityGML", url: "https://f/d_citygml.zip", format: "ZIP" }] },
    { name: "plateau-01100-sapporo-shi-2020", title: "札幌市", resources: [{ name: "目録", url: "https://f/e.xlsx", format: "XLSX" }] },
  ];
  const probe = async (url) => url.includes("/b_") ? { bytes: 3 * GB, method: "HEAD" } : null;
  const survey = await buildSurvey(datasets, probe);
  assert.equal(survey.cityGmlFileCount, 4);
  // 中央区は2023年度（3GB・問い合わせで判明）だけ。大阪市は説明文の概数4GB。合計7GB。
  assert.equal(survey.totals.latestPerCityBytes, 7 * GB);
  assert.equal(survey.totals.latestPerCityCities, 2);
  assert.equal(survey.rows.find((row) => row.dataset.endsWith("2022")).latestForCity, false);
  assert.equal(survey.rows.find((row) => row.dataset.endsWith("2023")).sizeSource, "問い合わせ(HEAD)");
  assert.equal(survey.rows.find((row) => row.dataset.includes("osaka")).sizeSource, "説明文の概数");
  // 名前から都市を読めないもの・大きさが分からないものは、別枠で数える。
  assert.equal(survey.totals.unclassifiedFiles, 1);
  assert.equal(survey.unknownSizeCount, 1);
  assert.deepEqual(survey.datasetsWithoutCityGml, ["plateau-01100-sapporo-shi-2020"]);
});

test("end to end against a mock catalogue: paging, HEAD / Range size probes, result files", async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/3/action/package_search") {
      const start = Number(url.searchParams.get("start"));
      const all = Array.from({ length: 5 }, (_, index) => ({
        name: `plateau-1310${index + 1}-ku-2023`,
        title: `PLATEAU ${index}`,
        resources: [{ name: "CityGML", format: "ZIP", url: `http://localhost:${server.address().port}/files/${index}_citygml.zip` }],
      })).concat([{ name: "unrelated", title: "関係ないデータ", resources: [] }]);
      const rows = Number(url.searchParams.get("rows"));
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ success: true, result: { count: all.length, results: all.slice(start, start + rows) } }));
      return;
    }
    const file = /^\/files\/(\d)_citygml\.zip$/.exec(url.pathname);
    if (file) {
      const size = (Number(file[1]) + 1) * 1000;
      if (request.method === "HEAD" && Number(file[1]) % 2 === 0) {
        response.setHeader("Content-Length", String(size));
        response.end();
        return;
      }
      if (request.method === "HEAD") {
        // HEADに大きさを返さないサーバー。
        response.statusCode = 405;
        response.end();
        return;
      }
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes 0-0/${size}`);
      response.end("x");
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const output = await mkdtemp(path.join(os.tmpdir(), "plateau-survey-"));
  try {
    const script = fileURLToPath(new URL("./plateau-size-survey.mjs", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [script], {
      env: {
        ...process.env,
        PLATEAU_CATALOG_API: `http://127.0.0.1:${server.address().port}/api/3/action/package_search`,
        PLATEAU_SURVEY_OUTPUT_DIR: output,
        HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "", NO_PROXY: "*",
      },
    });
    assert.match(stdout, /PLATEAUのデータセット: 5 件/);
    const survey = JSON.parse(await readFile(path.join(output, "plateau-size-survey-result.json"), "utf8"));
    assert.equal(survey.cityGmlFileCount, 5);
    assert.equal(survey.unknownSizeCount, 0);
    // 1000+2000+3000+4000+5000 バイト（偶数番はHEAD、奇数番はRangeで判明）。
    assert.equal(survey.totals.latestPerCityBytes, 15_000);
    assert.deepEqual(survey.rows.map((row) => row.sizeSource).sort(), ["問い合わせ(HEAD)", "問い合わせ(HEAD)", "問い合わせ(HEAD)", "問い合わせ(Range)", "問い合わせ(Range)"]);
    const csv = await readFile(path.join(output, "plateau-size-survey-result.csv"), "utf8");
    assert.ok(csv.startsWith("﻿\"dataset\"") || csv.startsWith("﻿dataset"));
    assert.equal(csv.trim().split("\r\n").length, 6);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
