// PLATEAU建物容量調査の道具: 手作りのZIPと模擬のファイル置き場で、最初から最後まで動かして確認する。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { classifyEntry, selectTargets, summarizeDirectory, surveyArchive, versionFromResourceName } from "./plateau-bldg-survey.mjs";

/** 無圧縮のZIPを作る。zip64=true のときは、大きさと位置をすべてZIP64の欄に書く。 */
function makeZip(files, { zip64 = false, declared = {} } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body] of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const size = declared[name] ?? { compressed: body.length, uncompressed: body.length };
    const extra = zip64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(size.uncompressed), 4);
      extra.writeBigUInt64LE(BigInt(size.compressed), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(zip64 ? 0xffffffff : size.compressed, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : size.uncompressed, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, nameBytes, extra);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(BigInt(files.length), 24);
    record.writeBigUInt64LE(BigInt(files.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : files.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : files.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, directory, ...tail, eocd]);
}

const FILES = [
  ["13101_chiyoda-ku_2023_citygml_1_op/udx/bldg/53394611_bldg_6697_op.gml", Buffer.alloc(5000, 1)],
  ["13101_chiyoda-ku_2023_citygml_1_op/udx/bldg/53394612_bldg_6697_op.gml", Buffer.alloc(3000, 2)],
  ["13101_chiyoda-ku_2023_citygml_1_op/udx/bldg/53394611_bldg_6697_appearance/a.jpg", Buffer.alloc(70_000, 3)],
  ["13101_chiyoda-ku_2023_citygml_1_op/udx/tran/53394611_tran_6697_op.gml", Buffer.alloc(900, 4)],
  ["13101_chiyoda-ku_2023_citygml_1_op/udx/bldg/", Buffer.alloc(0)],
  ["13101_chiyoda-ku_2023_citygml_1_op/metadata/meta.xml", Buffer.alloc(100, 5)],
];
const FIVE_GB = 5 * 1024 ** 3;

function startServer(archives) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const body = archives[request.url];
    if (!body) { response.writeHead(404).end(); return; }
    const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range ?? "");
    requests.push({ url: request.url, range: request.headers.range ?? null });
    if (!range || request.url.startsWith("/norange")) {
      response.writeHead(200, { "content-length": body.length }).end(body);
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), body.length - 1);
    response.writeHead(206, { "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
    response.end(body.subarray(start, end + 1));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` })));
}

test("classifies archive paths and picks the newest version per city", () => {
  assert.equal(classifyEntry("x/udx/bldg/a.gml"), "bldg-gml");
  assert.equal(classifyEntry("udx\\bldg\\A.GML"), "bldg-gml");
  assert.equal(classifyEntry("x/udx/bldg/a_appearance/t.jpg"), "bldg-other");
  assert.equal(classifyEntry("x/udx/tran/a.gml"), "udx/tran");
  assert.equal(classifyEntry("x/codelists/a.xml"), "other");
  assert.equal(classifyEntry("x/udx/bldg/"), null);
  assert.equal(versionFromResourceName("CityGML（ｖ４）"), 4);
  assert.equal(versionFromResourceName("CityGML"), 1);
  const targets = selectTargets([
    { dataset: "plateau-22130-hamamatsu-shi-2023", cityCode: "22130", year: 2023, resourceName: "CityGML（v3）", url: "u3", bytes: 9 },
    { dataset: "plateau-22130-hamamatsu-shi-2023", cityCode: "22130", year: 2023, resourceName: "CityGML（v4）", url: "u4", bytes: 5 },
    { dataset: "plateau-22130-hamamatsu-shi-2020", cityCode: "22130", year: 2020, resourceName: "CityGML（v9）", url: "old", bytes: 99 },
    { dataset: "plateau-tokyo23ku-2022", cityCode: null, year: 2022, resourceName: "CityGML", url: "t", bytes: 1 },
  ]);
  assert.deepEqual(targets.map((target) => target.url), ["u4", "t"]);
});

test("reads only the directory of plain and ZIP64 archives over partial requests", async () => {
  const plain = makeZip(FILES);
  // 目次が末尾の読み取り幅に収まらない場合（目次を別に取りに行く経路）も通す。
  const many = makeZip(Array.from({ length: 6000 }, (_, index) => [`c/udx/bldg/${String(index).padStart(60, "0")}.gml`, Buffer.alloc(1)]));
  const big = makeZip(FILES, { zip64: true, declared: { [FILES[0][0]]: { compressed: FIVE_GB, uncompressed: FIVE_GB * 4 } } });
  const { server, requests, base } = await startServer({ "/plain.zip": plain, "/many.zip": many, "/big.zip": big, "/norange.zip": plain, "/a.7z": plain });
  try {
    const target = (name) => ({ key: name, dataset: name, title: name, cityCode: null, year: 2023, version: 1, url: `${base}/${name}`, bytes: null });
    const a = await surveyArchive(target("plain.zip"));
    assert.equal(a.status, "ok");
    assert.equal(a.zipBytes, plain.length);
    assert.equal(a.zip64, false);
    assert.equal(a.entries, 6);
    assert.deepEqual(a.categories["bldg-gml"], { files: 2, compressedBytes: 8000, uncompressedBytes: 8000 });
    assert.deepEqual(a.categories["bldg-other"], { files: 1, compressedBytes: 70_000, uncompressedBytes: 70_000 });
    assert.equal(a.categories["udx/tran"].files, 1);
    assert.equal(a.categories.other.files, 1);

    const m = await surveyArchive(target("many.zip"));
    assert.equal(m.status, "ok");
    assert.equal(m.categories["bldg-gml"].files, 6000);
    assert.ok(m.directoryBytes > 256 * 1024);

    const b = await surveyArchive(target("big.zip"));
    assert.equal(b.status, "ok");
    assert.equal(b.zip64, true);
    assert.deepEqual(b.categories["bldg-gml"], { files: 2, compressedBytes: FIVE_GB + 3000, uncompressedBytes: FIVE_GB * 4 + 3000 });

    assert.equal((await surveyArchive(target("norange.zip"))).status, "range-unsupported");
    assert.equal((await surveyArchive(target("a.7z"))).status, "not-zip");
    assert.equal(requests.filter((request) => request.url === "/a.7z").length, 0);
    // 本体をまるごと要求していないこと。
    assert.ok(requests.every((request) => request.range));
  } finally {
    server.close();
  }
});

test("stops at a broken directory instead of reporting partial totals as complete", () => {
  const zip = makeZip(FILES);
  const start = zip.readUInt32LE(zip.length - 6);
  const directory = Buffer.from(zip.subarray(start, zip.length - 22));
  directory.writeUInt32LE(0, 46 + FILES[0][0].length);
  assert.equal(summarizeDirectory(directory).entries, 1);
});

test("runs end to end and writes the result files", async () => {
  const { server, base } = await startServer({ "/plain.zip": makeZip(FILES), "/norange.zip": makeZip(FILES) });
  const directory = await mkdtemp(path.join(os.tmpdir(), "plateau-bldg-"));
  try {
    const targetsPath = path.join(directory, "targets.json");
    await writeFile(targetsPath, JSON.stringify({ rows: [
      { dataset: "plateau-13101-chiyoda-ku-2023", title: "千代田区", cityCode: "13101", year: 2023, resourceName: "CityGML", url: `${base}/plain.zip`, bytes: 1 },
      { dataset: "plateau-13102-chuo-ku-2023", title: "中央区", cityCode: "13102", year: 2023, resourceName: "CityGML", url: `${base}/norange.zip`, bytes: 77 },
    ] }));
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "plateau-bldg-survey.mjs");
    const { stdout } = await promisify(execFile)(process.execPath, [script], {
      env: { ...process.env, PLATEAU_BLDG_TARGETS: targetsPath, PLATEAU_SURVEY_OUTPUT_DIR: directory },
    });
    assert.match(stdout, /目次を読めたZIP: 1 \/ 2 個/u);
    const result = JSON.parse(await readFile(path.join(directory, "plateau-bldg-survey-result.json"), "utf8"));
    assert.equal(result.totals.bldgGmlFiles, 2);
    assert.equal(result.totals.bldgGmlCompressedBytes, 8000);
    assert.equal(result.notReadCount, 1);
    assert.equal(result.notReadZipBytes, 77);
    const csv = await readFile(path.join(directory, "plateau-bldg-survey-result.csv"), "utf8");
    assert.equal(csv.split("\r\n").length, 4);
  } finally {
    server.close();
  }
});
